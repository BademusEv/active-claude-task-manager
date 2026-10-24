// Draws the app icon (a session list: working, waiting, idle) as a 1024 px PNG.
// Usage: swift scripts/make-icon.swift <out.png>
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments[1]
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

// macOS icon grid: an 824 px rounded square centred on the canvas.
let body = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
NSGradient(starting: rgb(0x2a2f37), ending: rgb(0x111316))!.draw(in: shape, angle: -90)
rgb(0xffffff, 0.08).setStroke()
shape.lineWidth = 4
shape.stroke()

// Three rows, top to bottom: working (green), waiting (blue), idle (grey).
let rows: [(UInt32, CGFloat, CGFloat)] = [(0x6cc38a, 1.0, 0.92), (0x6aa8ff, 0.8, 0.92), (0x5c626b, 0.6, 0.45)]
for (i, row) in rows.enumerated() {
    let (dot, barScale, barAlpha) = row
    let y = 650 - CGFloat(i) * 190
    let dotRect = NSRect(x: 230, y: y - 42, width: 84, height: 84)
    if i < 2 {
        rgb(dot, 0.28).setFill()
        NSBezierPath(ovalIn: dotRect.insetBy(dx: -22, dy: -22)).fill()
    }
    rgb(dot).setFill()
    NSBezierPath(ovalIn: dotRect).fill()
    let bar = NSRect(x: 372, y: y - 30, width: 420 * barScale, height: 60)
    rgb(0xe6e8eb, barAlpha).setFill()
    NSBezierPath(roundedRect: bar, xRadius: 30, yRadius: 30).fill()
}

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
