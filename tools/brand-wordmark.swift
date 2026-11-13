import Foundation
import CoreText
import CoreGraphics

// Development-only outline exporter. Never copy the font file into the product.
let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 96, nil)
guard CTFontCopyPostScriptName(font) as String == "Helvetica-Bold" else {
    fatalError("The canonical wordmark requires Helvetica-Bold")
}
let text = NSAttributedString(string: "aBridge", attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
])
// Keep the double-storey a, trimming its flared lower-right terminal to the
// vertical stem edge. Coordinates belong to the canonical 96-point outline.
func flattenPrefixTerminal(_ source: CGPath) -> CGPath {
    let path = CGMutablePath()
    func point(_ original: CGPoint) -> CGPoint {
        CGPoint(x: min(original.x, 47.765625), y: original.y)
    }
    source.applyWithBlock { pointer in
        let element = pointer.pointee
        switch element.type {
        case .moveToPoint: path.move(to: point(element.points[0]))
        case .addLineToPoint: path.addLine(to: point(element.points[0]))
        case .addQuadCurveToPoint:
            path.addQuadCurve(to: point(element.points[1]), control: point(element.points[0]))
        case .addCurveToPoint:
            path.addCurve(to: point(element.points[2]), control1: point(element.points[0]), control2: point(element.points[1]))
        case .closeSubpath: path.closeSubpath()
        @unknown default: fatalError("Unsupported glyph path segment")
        }
    }
    return path
}
let line = CTLineCreateWithAttributedString(text)
var outlines: [(CGPath, Bool)] = []
var bounds = CGRect.null
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
    let count = CTRunGetGlyphCount(run)
    var glyphs = [CGGlyph](repeating: 0, count: count)
    var positions = [CGPoint](repeating: .zero, count: count)
    var indices = [CFIndex](repeating: 0, count: count)
    CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
    CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
    CTRunGetStringIndices(run, CFRange(location: 0, length: 0), &indices)
    for index in 0..<count {
        var transform = CGAffineTransform(translationX: positions[index].x, y: positions[index].y)
        guard let raw = CTFontCreatePathForGlyph(font, glyphs[index], nil) else {
            fatalError("Missing Helvetica-Bold outline")
        }
        let glyph = indices[index] == 0 ? flattenPrefixTerminal(raw) : raw
        guard let path = glyph.copy(using: &transform) else {
            fatalError("Missing Helvetica-Bold outline")
        }
        outlines.append((path, indices[index] == 0))
        bounds = bounds.union(path.boundingBoxOfPath)
    }
}
func number(_ value: CGFloat) -> String {
    String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), Double(value))
}
func coordinates(_ points: UnsafePointer<CGPoint>, _ count: Int) -> String {
    (0..<count).map { "\(number(points[$0].x)) \(number(points[$0].y))" }.joined(separator: " ")
}
func outline(_ path: CGPath) -> String {
    var commands: [String] = []
    path.applyWithBlock { pointer in
        let element = pointer.pointee
        switch element.type {
        case .moveToPoint: commands.append("M " + coordinates(element.points, 1))
        case .addLineToPoint: commands.append("L " + coordinates(element.points, 1))
        case .addQuadCurveToPoint: commands.append("Q " + coordinates(element.points, 2))
        case .addCurveToPoint: commands.append("C " + coordinates(element.points, 3))
        case .closeSubpath: commands.append("Z")
        @unknown default: fatalError("Unsupported glyph path segment")
        }
    }
    return commands.joined(separator: " ")
}
let padding: CGFloat = 4
let width = bounds.width + padding * 2
let height = bounds.height + padding * 2
let paths = outlines.map { path, isPrefix in
    "<path fill=\"\(isPrefix ? "#4D94E8" : "#0066DD")\" d=\"\(outline(path))\"/>"
}.joined(separator: "\n")
print("""
<svg xmlns="http://www.w3.org/2000/svg" width="\(number(width))" height="\(number(height))" viewBox="0 0 \(number(width)) \(number(height))" role="img" aria-label="aBridge">
<title>aBridge — custom Helvetica Bold wordmark</title>
<g transform="translate(\(number(padding - bounds.minX)) \(number(padding + bounds.maxY))) scale(1 -1)">
\(paths)
</g>
</svg>
""")
