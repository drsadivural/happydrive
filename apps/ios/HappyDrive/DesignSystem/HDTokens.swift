// generated from packages/design-tokens/tokens.json — do not edit
import SwiftUI
import UIKit

extension Color {
    init(light: (Double, Double, Double), dark: (Double, Double, Double)) {
        self.init(UIColor { trait in
            let c = trait.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }
}

enum HDColor {
    static let brandBlue = Color(light: (0.043, 0.435, 0.941), dark: (0.298, 0.608, 1.000))
    static let brandBlueSoft = Color(light: (0.910, 0.945, 0.996), dark: (0.082, 0.141, 0.231))
    static let jobGreen = Color(light: (0.086, 0.592, 0.353), dark: (0.235, 0.769, 0.498))
    static let jobGreenSoft = Color(light: (0.902, 0.961, 0.925), dark: (0.071, 0.196, 0.137))
    static let corporatePurple = Color(light: (0.478, 0.302, 0.878), dark: (0.663, 0.541, 0.961))
    static let communityOrange = Color(light: (0.894, 0.541, 0.071), dark: (0.957, 0.663, 0.271))
    static let danger = Color(light: (0.851, 0.227, 0.227), dark: (1.000, 0.420, 0.420))
    static let warning = Color(light: (0.722, 0.431, 0.000), dark: (0.957, 0.702, 0.290))
    static let navy = Color(light: (0.043, 0.122, 0.294), dark: (0.039, 0.090, 0.200))
    static let textPrimary = Color(light: (0.059, 0.106, 0.200), dark: (0.949, 0.961, 0.980))
    static let textSecondary = Color(light: (0.337, 0.384, 0.478), dark: (0.655, 0.694, 0.769))
    static let background = Color(light: (0.953, 0.965, 0.984), dark: (0.043, 0.071, 0.125))
    static let surface = Color(light: (1.000, 1.000, 1.000), dark: (0.078, 0.114, 0.180))
    static let border = Color(light: (0.867, 0.894, 0.937), dark: (0.149, 0.196, 0.290))
    static let onBrand = Color(light: (1.000, 1.000, 1.000), dark: (1.000, 1.000, 1.000))
}

enum HDRadius {
    static let card: CGFloat = 16
    static let button: CGFloat = 12
    static let chip: CGFloat = 999
}

enum HDSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    static let minTapTarget: CGFloat = 44
}

enum HDCategoryStyle {
    static func style(for code: String) -> (label: String, color: Color) {
        switch code {
        case "elderly_watch": return ("高齢者見守り", HDColor.jobGreen)
        case "life_support": return ("生活支援", HDColor.jobGreen)
        case "shopping_assist": return ("買い物付き添い", HDColor.jobGreen)
        case "corporate_task": return ("企業依頼", HDColor.corporatePurple)
        case "community_info": return ("地域情報", HDColor.communityOrange)
        case "delivery_related": return ("配送関連", HDColor.brandBlue)
        case "personal_care": return ("身体介護（要資格）", HDColor.danger)
        case "healthcare": return ("医療関連（要資格）", HDColor.danger)
        default: return (code, HDColor.textSecondary)
        }
    }
}
