const fs = require('fs');
const path = require('path');

// 定义文件路径
const sourcePath = path.join(__dirname, 'nat64套壳版混淆.js');
const targetPath = path.join(__dirname, '_worker.js');

try {
  // 检查源文件是否存在
  if (fs.existsSync(sourcePath)) {
    // 拷贝文件
    fs.copyFileSync(sourcePath, targetPath);
    console.log(`✅ 成功拷贝：${sourcePath} -> ${targetPath}`);
  } else {
    console.error(`❌ 错误：源文件不存在 ${sourcePath}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`❌ 构建失败：${err.message}`);
  process.exit(1);
}
