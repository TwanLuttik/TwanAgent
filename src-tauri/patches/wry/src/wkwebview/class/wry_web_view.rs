// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{collections::HashMap, sync::Mutex};

use objc2::{define_class, rc::Retained, runtime::Bool, DeclaredClass};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSEvent;
use objc2_foundation::{NSObjectProtocol, NSUUID};

#[cfg(target_os = "ios")]
use crate::wkwebview::ios::WKWebView::WKWebView;
#[cfg(target_os = "macos")]
use crate::{wkwebview::synthetic_mouse_events, DragDropEvent};
#[cfg(target_os = "ios")]
use objc2_ui_kit::UIEvent as NSEvent;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

pub struct WryWebViewIvars {
  pub(crate) is_child: bool,
  #[cfg(target_os = "macos")]
  pub(crate) drag_drop_handler: Box<dyn Fn(DragDropEvent) -> bool>,
  #[cfg(target_os = "macos")]
  pub(crate) accept_first_mouse: objc2::runtime::Bool,
  #[cfg(target_os = "ios")]
  pub(crate) input_accessory_view_builder: Option<Box<crate::InputAccessoryViewBuilder>>,
  pub(crate) custom_protocol_task_ids: Mutex<HashMap<usize, Retained<NSUUID>>>,
}

define_class!(
  #[unsafe(super(WKWebView))]
  #[ivars = WryWebViewIvars]
  pub struct WryWebView;

  /// Overridden NSView methods.
  impl WryWebView {
    #[unsafe(method(performKeyEquivalent:))]
    fn perform_key_equivalent(&self, event: &NSEvent) -> Bool {
      // This is a temporary workaround for https://github.com/tauri-apps/tauri/issues/9426
      // FIXME: When the webview is a child webview, performKeyEquivalent always return YES
      // and stop propagating the event to the window, hence the menu shortcut won't be
      // triggered. However, overriding this method also means the cmd+key event won't be
      // handled in webview, which means the key cannot be listened by JavaScript.
      if self.ivars().is_child {
        Bool::NO
      } else {
        unsafe { objc2::msg_send![super(self), performKeyEquivalent: event] }
      }
    }

    #[cfg(target_os = "macos")]
    #[unsafe(method(acceptsFirstMouse:))]
    fn accept_first_mouse(&self, _event: &NSEvent) -> Bool {
      self.ivars().accept_first_mouse
    }

    #[cfg(target_os = "ios")]
    #[unsafe(method_id(inputAccessoryView))]
    fn input_accessory_view(&self) -> Option<Retained<objc2_ui_kit::UIView>> {
      if let Some(builder) = &self.ivars().input_accessory_view_builder {
        builder(self)
      } else {
        unsafe { objc2::msg_send![super(self), inputAccessoryView] }
      }
    }
  }
  unsafe impl NSObjectProtocol for WryWebView {}

  // Synthetic mouse events
  #[cfg(target_os = "macos")]
  impl WryWebView {
    #[unsafe(method(otherMouseDown:))]
    fn other_mouse_down(&self, event: &NSEvent) {
      synthetic_mouse_events::other_mouse_down(self, event)
    }

    #[unsafe(method(otherMouseUp:))]
    fn other_mouse_up(&self, event: &NSEvent) {
      synthetic_mouse_events::other_mouse_up(self, event)
    }
  }
);

// Custom Protocol Task Checker
impl WryWebView {
  pub(crate) fn add_custom_task_key(&self, task_id: usize) -> Retained<NSUUID> {
    let task_uuid = NSUUID::new();
    self
      .ivars()
      .custom_protocol_task_ids
      .lock()
      .unwrap()
      .insert(task_id, task_uuid.clone());
    task_uuid
  }
  pub(crate) fn remove_custom_task_key(&self, task_id: usize) {
    self
      .ivars()
      .custom_protocol_task_ids
      .lock()
      .unwrap()
      .remove(&task_id);
  }
  pub(crate) fn get_custom_task_uuid(&self, task_id: usize) -> Option<Retained<NSUUID>> {
    self
      .ivars()
      .custom_protocol_task_ids
      .lock()
      .unwrap()
      .get(&task_id)
      .cloned()
  }
}
