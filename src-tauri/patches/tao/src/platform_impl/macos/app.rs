// Copyright 2014-2021 The winit contributors
// Copyright 2021-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0

use std::{collections::VecDeque, ffi::CStr, panic::{catch_unwind, AssertUnwindSafe}};

use objc2::{
  exception,
  runtime::{AnyClass as Class, ClassBuilder as ClassDecl, Sel},
};
use objc2_app_kit::{self as appkit, NSApplication, NSEvent, NSEventType};
use once_cell::sync::Lazy;

use super::{app_state::AppState, event::EventWrapper, util, DEVICE_ID};
use crate::event::{DeviceEvent, ElementState, Event};

pub struct AppClass(pub *const Class);
unsafe impl Send for AppClass {}
unsafe impl Sync for AppClass {}

pub static APP_CLASS: Lazy<AppClass> = Lazy::new(|| unsafe {
  let superclass = class!(NSApplication);
  let mut decl =
    ClassDecl::new(CStr::from_bytes_with_nul(b"TaoApp\0").unwrap(), superclass).unwrap();

  decl.add_method(sel!(sendEvent:), send_event as extern "C" fn(_, _, _));

  AppClass(decl.register())
});

// Normally, holding Cmd + any key never sends us a `keyUp` event for that key.
// Overriding `sendEvent:` like this fixes that. (https://stackoverflow.com/a/15294196)
// Fun fact: Firefox still has this bug! (https://bugzilla.mozilla.org/show_bug.cgi?id=1299553)
extern "C" fn send_event(this: &NSApplication, _sel: Sel, event: &NSEvent) {
  // AppKit cannot unwind through this callback. A Rust panic becomes
  // `panic_cannot_unwind` and abort()s the process (2026-10-09). An
  // Objective-C exception is worse: `catch_unwind` does not catch it, so it
  // hits `__rust_foreign_exception` and abort()s anyway (2026-10-19). Catch
  // both before returning across the FFI boundary, and drop the event.
  // `NSApplication` and `NSEvent` are not `UnwindSafe`. That only means
  // they are not *proven* safe to observe after an unwind; we never touch
  // them again if either catch fires, so asserting it here is sound.
  let _ = guard_event_dispatch(AssertUnwindSafe(|| unsafe {
    dispatch_event(this, event);
  }));
}

unsafe fn dispatch_event(this: &NSApplication, event: &NSEvent) {
  // For posterity, there are some undocumented event types
  // (https://github.com/servo/cocoa-rs/issues/155)
  // but that doesn't really matter here.
  let event_type = event.r#type();
  let modifier_flags = event.modifierFlags();
  if event_type == appkit::NSKeyUp
    && util::has_flag(modifier_flags, appkit::NSEventModifierFlags::Command)
  {
    if let Some(key_window) = this.keyWindow() {
      key_window.sendEvent(event);
    } else {
      log::debug!("skip sending CMD keyEvent - app has no keyWindow");
    }
    return;
  }

  maybe_dispatch_device_event(event);
  let superclass = util::superclass(this);
  let _: () = msg_send![super(this, superclass), sendEvent: event];
}

fn exception_message(exception: Option<&exception::Exception>) -> String {
  match exception {
    Some(exception) => exception.to_string(),
    None => "nil exception".to_string(),
  }
}

/// Run `body` the way `sendEvent:` does: catch an Objective-C exception first,
/// then a Rust panic. Either one used to cross back into AppKit and `abort()`.
///
/// Returns `Ok(())` when `body` finishes, `Err(true)` when an Objective-C
/// exception was caught, and `Err(false)` when a Rust panic was caught.
pub(crate) fn guard_event_dispatch(body: impl FnOnce() + std::panic::UnwindSafe) -> Result<(), bool> {
  let mut saw_exception = false;
  let dispatched = catch_unwind(AssertUnwindSafe(|| {
    if let Err(exception) = exception::catch(body) {
      saw_exception = true;
      log::error!(
        "dropped an AppKit event after an Objective-C exception in sendEvent: {}",
        exception_message(exception.as_deref())
      );
    }
  }));
  match dispatched {
    Ok(()) if !saw_exception => Ok(()),
    Ok(()) => Err(true),
    Err(payload) => {
      log::error!(
        "dropped an AppKit event after a panic in sendEvent: {}",
        panic_message(&payload)
      );
      Err(false)
    }
  }
}

#[cfg(test)]
mod send_event_guard_tests {
  use super::guard_event_dispatch;
  use objc2::{
    exception::{throw, Exception},
    rc::Retained,
    runtime::NSObject,
  };
  use std::panic::AssertUnwindSafe;

  #[test]
  fn objective_c_exception_is_caught_instead_of_aborting() {
    // `catch_unwind` alone does not catch this. objc2's own test for that
    // path is `#[ignore = "currently aborts"]`. `exception::catch` must run
    // first, which is what `sendEvent:` now does.
    let obj = NSObject::new();
    let exception: Retained<Exception> = unsafe { Retained::cast_unchecked(obj) };
    let result = guard_event_dispatch(AssertUnwindSafe(|| throw(exception)));
    assert_eq!(result, Err(true));
  }

  #[test]
  fn rust_panic_is_caught_instead_of_aborting() {
    let result = guard_event_dispatch(AssertUnwindSafe(|| panic!("boom")));
    assert_eq!(result, Err(false));
  }

  #[test]
  fn successful_dispatch_is_ok() {
    let mut ran = false;
    let result = guard_event_dispatch(AssertUnwindSafe(|| ran = true));
    assert_eq!(result, Ok(()));
    assert!(ran);
  }
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
  if let Some(message) = payload.downcast_ref::<&str>() {
    return (*message).to_string();
  }
  if let Some(message) = payload.downcast_ref::<String>() {
    return message.clone();
  }
  "non-string panic payload".to_string()
}

fn maybe_dispatch_device_event(event: &NSEvent) {
  let event_type = event.r#type();
  match event_type {
    NSEventType::MouseMoved
    | NSEventType::LeftMouseDragged
    | NSEventType::OtherMouseDragged
    | NSEventType::RightMouseDragged => {
      let mut events = VecDeque::with_capacity(3);

      let delta_x = event.deltaX() as f64;
      let delta_y = event.deltaY() as f64;

      if delta_x != 0.0 {
        events.push_back(EventWrapper::StaticEvent(Event::DeviceEvent {
          device_id: DEVICE_ID,
          event: DeviceEvent::Motion {
            axis: 0,
            value: delta_x,
          },
        }));
      }

      if delta_y != 0.0 {
        events.push_back(EventWrapper::StaticEvent(Event::DeviceEvent {
          device_id: DEVICE_ID,
          event: DeviceEvent::Motion {
            axis: 1,
            value: delta_y,
          },
        }));
      }

      if delta_x != 0.0 || delta_y != 0.0 {
        events.push_back(EventWrapper::StaticEvent(Event::DeviceEvent {
          device_id: DEVICE_ID,
          event: DeviceEvent::MouseMotion {
            delta: (delta_x, delta_y),
          },
        }));
      }

      AppState::queue_events(events);
    }
    NSEventType::LeftMouseDown | NSEventType::RightMouseDown | NSEventType::OtherMouseDown => {
      let mut events = VecDeque::with_capacity(1);

      events.push_back(EventWrapper::StaticEvent(Event::DeviceEvent {
        device_id: DEVICE_ID,
        event: DeviceEvent::Button {
          button: event.buttonNumber() as u32,
          state: ElementState::Pressed,
        },
      }));

      AppState::queue_events(events);
    }
    NSEventType::LeftMouseUp | NSEventType::RightMouseUp | NSEventType::OtherMouseUp => {
      let mut events = VecDeque::with_capacity(1);

      events.push_back(EventWrapper::StaticEvent(Event::DeviceEvent {
        device_id: DEVICE_ID,
        event: DeviceEvent::Button {
          button: event.buttonNumber() as u32,
          state: ElementState::Released,
        },
      }));

      AppState::queue_events(events);
    }
    _ => (),
  }
}
