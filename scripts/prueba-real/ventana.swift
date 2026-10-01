// Busca el aviso de spoochie en pantalla y, si se le pide, lo pulsa con el raton.
//
//   swift ventana.swift permiso         "si" si macOS deja a este proceso mandar clics
//   swift ventana.swift buscar          imprime "x y ancho alto" del aviso, o nada
//   swift ventana.swift terminal TEXTO   id de la ventana de Terminal con ese texto en el titulo
//   swift ventana.swift pulsar X Y      mueve el raton a (X, Y) y hace un clic izquierdo
//   swift ventana.swift teclas 125 36   pulsa esas teclas (codigos virtuales) donde este el foco
//
// El aviso es un NSWindow de osascript, flotante y de 440 de ancho. Un clic de verdad,
// con CGEvent, es lo que hace una persona: el clic del 01-10 que no llegaba al demonio
// solo se ve asi, no con performClick dentro del guion.
import Foundation
import CoreGraphics
import ApplicationServices

let args = CommandLine.arguments
// Sin permiso de Accesibilidad para la app desde la que corre esto, macOS tira los
// clics y las teclas sin decir nada. Se pregunta antes de empezar.
if args.count >= 2 && args[1] == "permiso" { print(AXIsProcessTrusted() ? "si" : "no"); exit(0) }
if args.count >= 2 && args[1] == "buscar" {
  let lista = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in lista {
    guard (w[kCGWindowOwnerName as String] as? String) == "osascript",
          let b = w[kCGWindowBounds as String] as? [String: CGFloat],
          let ancho = b["Width"], let alto = b["Height"], ancho == 440 else { continue }
    print("\(Int(b["X"]!)) \(Int(b["Y"]!)) \(Int(ancho)) \(Int(alto))")
    exit(0)
  }
  exit(1)
}
// El id de la ventana de Terminal cuyo titulo contiene ese texto, para `screencapture -l`.
// Asi la captura es esa ventana y nada mas: ni el Slack ni el correo de quien la corre.
if args.count >= 3 && args[1] == "terminal" {
  let lista = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in lista where (w[kCGWindowOwnerName as String] as? String) == "Terminal" {
    if let n = w[kCGWindowName as String] as? String, n.contains(args[2]), let id = w[kCGWindowNumber as String] as? Int { print(id); exit(0) }
  }
  exit(1)
}
if args.count >= 4 && args[1] == "pulsar", let x = Double(args[2]), let y = Double(args[3]) {
  let p = CGPoint(x: x, y: y)
  let src = CGEventSource(stateID: .hidSystemState)
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(150_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(80_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  exit(0)
}
// Teclas a la ventana que tenga el foco: "teclas 125 36" es flecha abajo y Return. Sirve
// para el dialogo de confianza de Claude Code en un directorio nuevo, que cualquier
// persona contesta una vez en su repo y que aqui saldria en cada pasada.
if args.count >= 3 && args[1] == "teclas" {
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
FileHandle.standardError.write("uso: buscar | pulsar X Y\n".data(using: .utf8)!)
exit(2)
