import CoreGraphics
import Foundation

/// A modifier key Yap can listen on. Left and right are separate choices because the
/// event tap sees a keycode plus a device-specific flag, which the generic
/// CGEventFlags (maskCommand and friends) cannot tell apart.
enum TriggerKey: String, CaseIterable {
    case rightCommand
    case leftCommand
    case rightOption
    case leftOption
    case rightControl
    case leftControl
    case rightShift
    case leftShift
    case fn

    var title: String {
        switch self {
        case .rightCommand: return "Right \u{2318}"
        case .leftCommand: return "Left \u{2318}"
        case .rightOption: return "Right \u{2325}"
        case .leftOption: return "Left \u{2325}"
        case .rightControl: return "Right \u{2303}"
        case .leftControl: return "Left \u{2303}"
        case .rightShift: return "Right \u{21E7}"
        case .leftShift: return "Left \u{21E7}"
        case .fn: return "Fn"
        }
    }

    var keyCode: Int64 {
        switch self {
        case .rightCommand: return 54
        case .leftCommand: return 55
        case .rightOption: return 61
        case .leftOption: return 58
        case .rightControl: return 62
        case .leftControl: return 59
        case .rightShift: return 60
        case .leftShift: return 56
        case .fn: return 63
        }
    }

    /// Device-dependent modifier bits from IOLLEvent.h, the ones that distinguish sides.
    var flagMask: UInt64 {
        switch self {
        case .rightCommand: return 0x0010   // NX_DEVICERCMDKEYMASK
        case .leftCommand: return 0x0008    // NX_DEVICELCMDKEYMASK
        case .rightOption: return 0x0040    // NX_DEVICERALTKEYMASK
        case .leftOption: return 0x0020     // NX_DEVICELALTKEYMASK
        case .rightControl: return 0x2000   // NX_DEVICERCTLKEYMASK
        case .leftControl: return 0x0001    // NX_DEVICELCTLKEYMASK
        case .rightShift: return 0x0004     // NX_DEVICERSHIFTKEYMASK
        case .leftShift: return 0x0002      // NX_DEVICELSHIFTKEYMASK
        case .fn: return CGEventFlags.maskSecondaryFn.rawValue
        }
    }
}

/// Preferences from the menu bar, stored in UserDefaults so they survive a relaunch.
final class Settings {
    static let shared = Settings()

    private let triggerKeyName = "triggerKey"
    private let soundsName = "soundsEnabled"
    private let defaults = UserDefaults.standard

    private init() {
        defaults.register(defaults: [soundsName: true])
    }

    var triggerKey: TriggerKey {
        get { TriggerKey(rawValue: defaults.string(forKey: triggerKeyName) ?? "") ?? .rightCommand }
        set { defaults.set(newValue.rawValue, forKey: triggerKeyName) }
    }

    var soundsEnabled: Bool {
        get { defaults.bool(forKey: soundsName) }
        set { defaults.set(newValue, forKey: soundsName) }
    }
}
