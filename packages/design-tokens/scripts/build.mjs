// Generates CSS custom properties, a TS module and a Swift file from tokens.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8'));
const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
mkdirSync(join(root, 'dist'), { recursive: true });

const light = Object.entries(t.color).map(([k, v]) => `  --hd-${kebab(k)}: ${v.light};`).join('\n');
const dark = Object.entries(t.color).map(([k, v]) => `    --hd-${kebab(k)}: ${v.dark};`).join('\n');
const misc = [
  ...Object.entries(t.radius).map(([k, v]) => `  --hd-radius-${k}: ${v}px;`),
  ...Object.entries(t.spacing).map(([k, v]) => `  --hd-space-${k}: ${v}px;`),
  `  --hd-min-tap: ${t.minTapTarget}px;`,
  `  --hd-font: "${t.font.family}", ${t.font.fallback};`,
].join('\n');
writeFileSync(join(root, 'dist/tokens.css'),
  `/* generated from tokens.json — do not edit */\n:root {\n${light}\n${misc}\n  color-scheme: light dark;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n${dark}\n  }\n}\n`);

writeFileSync(join(root, 'dist/tokens.ts'),
  `// generated from tokens.json — do not edit\nexport const categories = ${JSON.stringify(t.category, null, 2)} as const;\nexport type JobCategoryKey = keyof typeof categories;\nexport const radius = ${JSON.stringify(t.radius)} as const;\nexport const spacing = ${JSON.stringify(t.spacing)} as const;\n`);

const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => (x / 255).toFixed(3)).join(', ');
};
const swiftColors = Object.entries(t.color).map(([k, v]) =>
  `    static let ${k} = Color(light: (${hex(v.light)}), dark: (${hex(v.dark)}))`).join('\n');
const swiftCats = Object.entries(t.category).map(([k, v]) => `        case "${k}": return ("${v.label}", HDColor.${v.color})`).join('\n');
writeFileSync(join(root, 'dist/HDTokens.swift'),
`// generated from packages/design-tokens/tokens.json — do not edit
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
${swiftColors}
}

enum HDRadius {
${Object.entries(t.radius).map(([k, v]) => `    static let ${k}: CGFloat = ${v}`).join('\n')}
}

enum HDSpacing {
${Object.entries(t.spacing).map(([k, v]) => `    static let ${k}: CGFloat = ${v}`).join('\n')}
    static let minTapTarget: CGFloat = ${t.minTapTarget}
}

enum HDCategoryStyle {
    static func style(for code: String) -> (label: String, color: Color) {
        switch code {
${swiftCats}
        default: return (code, HDColor.textSecondary)
        }
    }
}
`);
console.log('design tokens generated');
