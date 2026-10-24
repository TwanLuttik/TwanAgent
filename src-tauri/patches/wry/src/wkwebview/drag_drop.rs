// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{ffi::CStr, path::PathBuf};

use objc2::{
  define_class, msg_send,
  rc::Retained,
  runtime::{Bool, ProtocolObject},
  ClassType, DeclaredClass, MainThreadOnly,
};
use objc2_app_kit::{NSDragOperation, NSDraggingDestination, NSDraggingInfo, NSFilenamesPboardType, NSView};
use objc2_foundation::{NSArray, NSObjectProtocol, NSPoint, NSRect, NSString, NSURL};

use crate::DragDropEvent;

use super::WryWebView;

/// Sits above the webview and takes file drops. Overriding NSDraggingDestination
/// on the WKWebView subclass itself makes WebKit navigate to the dropped file,
/// which freezes the page after the first image. This view handles the file and
/// leaves WKWebView's drag methods alone.
pub struct FileDropViewIvars {
  handler: Box<dyn Fn(DragDropEvent) -> bool>,
}

define_class!(
  #[unsafe(super(NSView))]
  #[ivars = FileDropViewIvars]
  pub struct FileDropView;

  impl FileDropView {
    #[unsafe(method(hitTest:))]
    fn hit_test(&self, point: NSPoint) -> *mut NSView {
      // Clicks pass through so the page stays usable. During a drag, returning
      // null lets AppKit hand the drag to WKWebView underneath, and that view
      // navigates to the file. The second image is the one that freezes the
      // window, so this view is the hit only while a drag is in progress.
      let bounds = self.bounds();
      let inside = point.x >= bounds.origin.x
        && point.y >= bounds.origin.y
        && point.x < bounds.origin.x + bounds.size.width
        && point.y < bounds.origin.y + bounds.size.height;
      if !dragging_now() || !inside {
        return std::ptr::null_mut();
      }
      let this: *const FileDropView = self;
      this as *mut NSView
    }
  }

  unsafe impl NSObjectProtocol for FileDropView {}

  unsafe impl NSDraggingDestination for FileDropView {
    #[unsafe(method(draggingEntered:))]
    fn dragging_entered(
      &self,
      drag_info: &ProtocolObject<dyn NSDraggingInfo>,
    ) -> NSDragOperation {
      dragging_entered(self, drag_info)
    }

    #[unsafe(method(draggingUpdated:))]
    fn dragging_updated(
      &self,
      drag_info: &ProtocolObject<dyn NSDraggingInfo>,
    ) -> NSDragOperation {
      dragging_updated(self, drag_info)
    }

    #[unsafe(method(performDragOperation:))]
    fn perform_drag_operation(&self, drag_info: &ProtocolObject<dyn NSDraggingInfo>) -> Bool {
      perform_drag_operation(self, drag_info)
    }

    #[unsafe(method(draggingExited:))]
    fn dragging_exited(&self, drag_info: &ProtocolObject<dyn NSDraggingInfo>) {
      dragging_exited(self, drag_info)
    }
  }
);

impl FileDropView {
  pub fn attach(webview: &WryWebView, handler: Box<dyn Fn(DragDropEvent) -> bool>) {
    let mtm = MainThreadOnly::mtm(webview);
    let view = FileDropView::alloc(mtm).set_ivars(FileDropViewIvars { handler });
    let frame: NSRect = unsafe { msg_send![webview, bounds] };
    let view: Retained<FileDropView> =
      unsafe { msg_send![super(view), initWithFrame: frame] };
    view.setAutoresizingMask(
      objc2_app_kit::NSAutoresizingMaskOptions::ViewWidthSizable
        | objc2_app_kit::NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    // A layer-backed view is skipped by the drag hit test, so the second file
    // falls through to WKWebView and that navigation freezes the page. A layer
    // host is hit for the whole frame.
    let layer: Retained<objc2_quartz_core::CALayer> = unsafe { msg_send![objc2_quartz_core::CALayer::class(), layer] };
    unsafe {
      let _: () = msg_send![&*view, setLayer: &*layer];
      let _: () = msg_send![&*view, setWantsLayer: Bool::YES];
    }
    let types = unsafe {
      NSArray::from_slice(&[
        objc2_app_kit::NSPasteboardTypeFileURL,
        #[allow(deprecated)]
        NSFilenamesPboardType,
      ])
    };
    view.registerForDraggedTypes(&types);
    unsafe { msg_send![webview, addSubview: &*view] }
  }
}

fn listener(view: &FileDropView) -> &dyn Fn(DragDropEvent) -> bool {
  view.ivars().handler.as_ref()
}

fn dragging_now() -> bool {
  let Some(mtm) = objc2::MainThreadMarker::new() else {
    return false;
  };
  let Some(event) = objc2_app_kit::NSApplication::sharedApplication(mtm).currentEvent() else {
    return false;
  };
  // AppKitDefined covers the events sent while a drag is over the window.
  matches!(
    event.r#type(),
    objc2_app_kit::NSEventType::LeftMouseDragged
      | objc2_app_kit::NSEventType::RightMouseDragged
      | objc2_app_kit::NSEventType::OtherMouseDragged
      | objc2_app_kit::NSEventType::AppKitDefined
  )
}

pub(crate) unsafe fn collect_paths(drag_info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
  let pb = drag_info.draggingPasteboard();
  let mut drag_drop_paths = Vec::new();

  // Finder publishes public.file-url. The legacy filename list is often absent,
  // and unwrapping it panics. A panic on the second drop leaves WKWebView's drag
  // session running, so the view keeps animating but stops receiving mouse clicks.
  let classes = NSArray::from_slice(&[NSURL::class()]);
  if let Some(items) = pb.readObjectsForClasses_options(&classes, None) {
    for item in items {
      let Some(url) = item.downcast_ref::<NSURL>() else {
        continue;
      };
      if !url.isFileURL() {
        continue;
      }
      let Some(path) = url.filePathURL().and_then(|url| url.path()) else {
        continue;
      };
      let path = CStr::from_ptr(path.UTF8String()).to_string_lossy();
      drag_drop_paths.push(PathBuf::from(path.into_owned()));
    }
    if !drag_drop_paths.is_empty() {
      return drag_drop_paths;
    }
  }

  #[allow(deprecated)]
  if let Some(paths) = pb.propertyListForType(NSFilenamesPboardType) {
    if let Ok(paths) = paths.downcast::<NSArray>() {
      for path in paths {
        let Ok(path) = path.downcast::<NSString>() else {
          continue;
        };
        let path = CStr::from_ptr(path.UTF8String()).to_string_lossy();
        drag_drop_paths.push(PathBuf::from(path.into_owned()));
      }
    }
  }
  drag_drop_paths
}

fn dragging_entered(
  this: &FileDropView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  // Declining sends the drag on to WKWebView. Accepting it here keeps WebKit from
  // navigating to the file, which is what freezes the page after the first image.
  if listener(this)(DragDropEvent::Enter { paths, position }) {
    NSDragOperation::Copy
  } else {
    NSDragOperation::None
  }
}

fn dragging_updated(
  this: &FileDropView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  if listener(this)(DragDropEvent::Over { position }) {
    NSDragOperation::Copy
  } else {
    NSDragOperation::None
  }
}

fn perform_drag_operation(
  this: &FileDropView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  if listener(this)(DragDropEvent::Drop { paths, position }) {
    Bool::YES
  } else {
    Bool::NO
  }
}

fn dragging_exited(this: &FileDropView, _drag_info: &ProtocolObject<dyn NSDraggingInfo>) {
  let _ = listener(this)(DragDropEvent::Leave);
}
