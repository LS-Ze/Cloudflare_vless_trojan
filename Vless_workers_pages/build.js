const fs = require('fs');
const path = require('path');

// 读取原文件
const sourceFile = 'nat64套壳版混淆.js';
const outputFile = '_worker.js';

if (!fs.existsSync(sourceFile)) {
  console.error('源文件不存在');
  process.exit(1);
}

// 读取文件内容
let content = fs.readFileSync(sourceFile, 'utf8');

// 修复 const 赋值问题：将所有 const 改为 let
// 注意：这可能会影响其他不该修改的 const
content = content.replace(/\bconst\b/g, 'let');

// 写入 _worker.js
fs.writeFileSync(outputFile, content);
console.log('构建完成');
