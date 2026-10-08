import Foundation
import Capacitor
import LocalAuthentication
import UIKit

/// Face ID / Touch ID for Hawwesh. This is a shortcut on top of the app PIN, never a replacement:
/// the web layer only uses it when a PIN exists, and any failure leaves the PIN screen in place.
///
/// JS side: window.Capacitor.Plugins.HawweshBiometrics (exported by Capacitor when the plugin is registered
/// in HawweshViewController.capacitorDidLoad()).
@objc(HawweshBiometricsPlugin)
public class HawweshBiometricsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HawweshBiometricsPlugin"
    public let jsName = "HawweshBiometrics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    /// Resolves { available: Bool, biometryType: "faceID" | "touchID" | "none", reason: String }.
    /// Never prompts the user: canEvaluatePolicy only inspects the device.
    @objc func isAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        call.resolve([
            "available": available,
            "biometryType": available ? Self.typeName(context.biometryType) : "none",
            "reason": available ? "" : Self.reasonName(error)
        ])
    }

    /// Shows the system Face ID / Touch ID sheet. Options: reason, cancelTitle, fallbackTitle.
    /// An empty fallbackTitle hides the "Enter Password" button, so the only fallback is the Hawwesh PIN.
    /// Resolves { success: true }; rejects with a code (USER_CANCEL, AUTH_FAILED, NOT_ENROLLED, ...).
    @objc func authenticate(_ call: CAPPluginCall) {
        let context = LAContext()
        context.localizedFallbackTitle = call.getString("fallbackTitle") ?? ""
        if let cancelTitle = call.getString("cancelTitle"), !cancelTitle.isEmpty {
            context.localizedCancelTitle = cancelTitle
        }
        let reason = call.getString("reason") ?? "Unlock"

        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &policyError) else {
            let code = Self.reasonName(policyError)
            call.reject("Biometrics unavailable", code, policyError)
            return
        }

        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, evaluateError in
            // LocalAuthentication replies on a private queue; Capacitor calls and UI belong on the main queue.
            DispatchQueue.main.async {
                if success {
                    call.resolve(["success": true])
                } else {
                    call.reject("Authentication failed", Self.reasonName(evaluateError), evaluateError)
                }
            }
        }
    }

    /// Opens the iOS Settings page of this app (used when notifications were denied).
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Settings unavailable")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("Settings unavailable") }
            }
        }
    }

    private static func typeName(_ type: LABiometryType) -> String {
        switch type {
        case .faceID: return "faceID"
        case .touchID: return "touchID"
        default: return "none"
        }
    }

    private static func reasonName(_ error: Error?) -> String {
        guard let error = error else { return "UNKNOWN" }
        let nsError = error as NSError
        guard nsError.domain == LAError.errorDomain, let code = LAError.Code(rawValue: nsError.code) else {
            return "UNKNOWN"
        }
        switch code {
        case .userCancel, .appCancel, .systemCancel: return "USER_CANCEL"
        case .authenticationFailed: return "AUTH_FAILED"
        case .biometryNotEnrolled: return "NOT_ENROLLED"
        case .biometryNotAvailable: return "NOT_AVAILABLE"
        case .biometryLockout: return "LOCKOUT"
        case .passcodeNotSet: return "PASSCODE_NOT_SET"
        case .userFallback: return "USER_FALLBACK"
        default: return "UNKNOWN"
        }
    }
}
