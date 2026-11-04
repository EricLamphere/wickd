// Prints the CGWindowID of a process's largest normal window, for
// `screencapture -l`. Matches on PID, so it needs no Screen Recording permission.
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int(CommandLine.arguments[1]) else {
  fputs("usage: windows.swift <pid>\n", stderr)
  exit(2)
}

// All windows, not just on-screen ones: the shell may be on another Space.
let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []

func area(_ window: [String: Any]) -> Double {
  let bounds = window[kCGWindowBounds as String] as? [String: Double] ?? [:]
  return (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
}

let owned = windows.filter {
  ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
}

guard let largest = owned.max(by: { area($0) < area($1) }),
  let number = largest[kCGWindowNumber as String] as? Int
else {
  fputs("no window for pid \(pid)\n", stderr)
  exit(1)
}
print(number)
