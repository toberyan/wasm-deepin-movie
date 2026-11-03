# Linux 安装包

该目录把 Web 构建封装成可双击启动的桌面应用。播放器仍是浏览器页面,但由
`wasm-player` 启动器在 `127.0.0.1` 上托管,并用 Chrome/Chromium/Edge 的 `--app`
窗口打开,不显示地址栏。

## .deb 安装

```bash
sudo dpkg -i dist/wasm-player_0.1.0_all.deb
```

安装后从应用菜单搜索 **WASM Player** 启动。需要把图标放到桌面时,在应用菜单中
右键选择“发送到桌面”,或手动复制:

```bash
cp /usr/share/applications/wasm-player.desktop ~/Desktop/
chmod +x ~/Desktop/wasm-player.desktop
```

卸载:

```bash
sudo dpkg -r wasm-player
```

## 免 root 便携包

```bash
tar -xzf dist/wasm-player-linux-x64-0.1.0.tar.gz
cd wasm-player-linux-x64
./install-user.sh
```

安装到 `~/.local/share/wasm-player`,并在 `~/Desktop/WASM Player.desktop` 创建快捷方式。
桌面环境若提示不受信任,右键允许启动即可。

## 依赖

- Python 3.10+ (`python3`)
- Chrome / Chromium / Microsoft Edge 任一
- 启动器优先使用 `WASM_PLAYER_BROWSER` 环境变量指定浏览器

## 重新构建

```bash
bash packaging/linux/build-deb.sh
bash packaging/linux/build-portable.sh
```

产物在 `dist/`。`.deb` 只包含本地播放器,不包含 Companion/MCP 服务。

## 当前限制

这是 alpha/内部试用包,不是生产发布版。已知限制:真 MT 仍回退 ST、无 PGS/VobSub、
未完成物理 GPU 长稳和完整兼容矩阵。自定义 FFmpeg WASM 的许可/专利审查完成前,
不要公开分发该包。
