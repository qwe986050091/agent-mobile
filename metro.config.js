// Expo SDK 57 (default Metro config). pnpm 的项目内 store 会造成庞大大目录被监视，
// 用 blockList 排除，避免 Metro/resolver 扫描其中文件影响性能。
// 注意：不要排除 node_modules/.pnpm（真实文件经 symlink 落在其中，排除会 break 解析）。
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.resolver.blockList = [/\.pnpm-store[\\/].*/]

module.exports = config