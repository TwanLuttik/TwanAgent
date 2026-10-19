use std::process::Command;

pub trait WindowlessCommand {
    fn hide_console_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl WindowlessCommand for Command {
    fn hide_console_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

#[cfg(windows)]
impl WindowlessCommand for tokio::process::Command {
    fn hide_console_window(&mut self) -> &mut Self {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

#[cfg(not(windows))]
impl WindowlessCommand for Command {
    fn hide_console_window(&mut self) -> &mut Self {
        self
    }
}

#[cfg(not(windows))]
impl WindowlessCommand for tokio::process::Command {
    fn hide_console_window(&mut self) -> &mut Self {
        self
    }
}
