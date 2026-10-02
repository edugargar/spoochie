// Finds the spoochie notice on screen and, if asked, clicks it with the mouse.
//
//   swift window.swift permission        "yes" if macOS lets this process send clicks
//   swift window.swift find              prints "x y width height" of the notice, or nothing
//   swift window.swift terminal TEXT     id of the Terminal window with that text in its title
//   swift window.swift click X Y         moves the mouse to (X, Y) and left-clicks
//   swift window.swift keys 125 36       presses those keys (virtual codes) wherever the focus is
//
// The notice is an osascript NSWindow, floating and 440 wide. A real click,
// with CGEvent, is what a person does: the 01-10 click that never reached the daemon
// only shows up this way, not with performClick inside the script.
import Foundation
import CoreGraphics
import ApplicationServices

let args = CommandLine.arguments
// Without Accessibility permission for the app this runs from, macOS drops the
// clicks and keys without a word. So we ask before starting.
if args.count >= 2 && args[1] == "permission" { print(AXIsProcessTrusted() ? "yes" : "no"); exit(0) }
if args.count >= 2 && args[1] == "find" {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in list {
    guard (w[kCGWindowOwnerName as String] as? String) == "osascript",
          let b = w[kCGWindowBounds as String] as? [String: CGFloat],
          let width = b["Width"], let height = b["Height"], width == 440 else { continue }
    print("\(Int(b["X"]!)) \(Int(b["Y"]!)) \(Int(width)) \(Int(height))")
    exit(0)
  }
  exit(1)
}
// The id of the Terminal window whose title contains that text, for `screencapture -l`.
// That way the capture is that window and nothing else: not the Slack or the mail of whoever runs it.
if args.count >= 3 && args[1] == "terminal" {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in list where (w[kCGWindowOwnerName as String] as? String) == "Terminal" {
    if let n = w[kCGWindowName as String] as? String, n.contains(args[2]), let id = w[kCGWindowNumber as String] as? Int { print(id); exit(0) }
  }
  exit(1)
}
if args.count >= 4 && args[1] == "click", let x = Double(args[2]), let y = Double(args[3]) {
  let p = CGPoint(x: x, y: y)
  let src = CGEventSource(stateID: .hidSystemState)
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(150_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(80_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  exit(0)
}
// Keys to the focused window: "keys 125 36" is down arrow and Return. It is for
// Claude Code's trust dialog in a new directory, which anyone answers once in
// their repo and which here would show up on every run.
if args.count >= 3 && args[1] == "keys" {
  let src = CGEventSource(stateID: .hidSystemState)
  for c in args.dropFirst(2) {
    guard let k = CGKeyCode(c) else { continue }
    CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: true)?.post(tap: .cghidEventTap)
    usleep(60_000)
    CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false)?.post(tap: .cghidEventTap)
    usleep(200_000)
  }
  exit(0)
}
FileHandle.standardError.write("usage: permission | find | terminal TEXT | click X Y | keys CODE...\n".data(using: .utf8)!)
exit(2)
