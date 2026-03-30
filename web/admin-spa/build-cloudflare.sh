#!/bin/bash
# Cloudflare Pages 构建脚本

set -e

echo "🚀 Starting Cloudflare Pages build..."

# 使用 Cloudflare 配置
echo "📦 Copying Cloudflare environment config..."
cp .env.cloudflare .env.production.local

# 安装依赖
echo "📦 Installing dependencies..."
npm install

# 构建
echo "🔨 Building..."
npm run build

echo "✅ Build completed successfully!"
echo "📁 Output directory: dist/"
