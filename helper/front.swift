// Prints one JSON line whenever the frontmost app or the number of on-screen
// Claude windows changes: {"front":"<bundle id>","frontPid":123,"claudeWindows":2}
// Polled every 250 ms; no Accessibility permission needed.
import AppKit

let claudeOwner = "Claude"
let parentPid = getppid()
var last = ""

func snapshot() -> String {
    let front = NSWorkspace.shared.frontmostApplication
    let frontId = front?.bundleIdentifier ?? ""
    let frontPid = front?.processIdentifier ?? -1
    var claudeWindows = 0
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    if let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] {
        for w in list {
            guard (w[kCGWindowOwnerName as String] as? String) == claudeOwner else { continue }
            guard (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
            if let b = w[kCGWindowBounds as String] as? [String: Any],
               let h = b["Height"] as? Double, h > 50 {
                claudeWindows += 1
            }
        }
    }
    let escaped = frontId.replacingOccurrences(of: "\"", with: "\\\"")
    return "{\"front\":\"\(escaped)\",\"frontPid\":\(frontPid),\"claudeWindows\":\(claudeWindows)}"
}

setvbuf(stdout, nil, _IOLBF, 0)
// NSWorkspace only refreshes frontmostApplication while a run loop spins, so
// poll from a timer on the main run loop instead of a sleep loop.
let timer = Timer(timeInterval: 0.25, repeats: true) { _ in
    // The widget died without stopping us: we were re-parented to launchd.
    if getppid() != parentPid { exit(0) }
    let s = snapshot()
    if s != last {
        last = s
        print(s)
    }
}
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
