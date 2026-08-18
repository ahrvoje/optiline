# Toolchain

- Native C: Visual Studio 2022 MSVC v143, `C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\cl.exe`; compile C99-compatible sources with `/TC /std:c17`.
- VS environment: `C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\Launch-VsDevShell.ps1`.
- CMake: `C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`.
- Ninja: `C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe`.
- Browser WASM C: WASI SDK 33.0, `C:\repos\optiline\tools\wasi-sdk-33.0-x86_64-windows\bin\clang.exe`; compile with `--target=wasm32-wasip1 -std=c99`, link with `-mexec-model=reactor`.
- Web: Node `C:\nvm4w\nodejs\node.exe`; npm `C:\nvm4w\nodejs\npm.cmd`; Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- Browser tests: Playwright 1.62.1, `C:\repos\optiline\node_modules\.bin\playwright.cmd`; bundled Chromium, `C:\Users\<USERNAME>\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe`.
- GPU: Chrome WebGPU with WGSL compute/render shaders.

# Python, wcap, ffmpeg, style

Use Python interpreter at:
c:\Users\<USERNAME>\AppData\Local\Programs\Python\Python314\

Screen capture utility
C:\store\download\wcap-x64.exe

Use ffmpeg at:
C:\Users\<USERNAME>\AppData\Local\Programs\utils\ffmpeg\bin\ffmpeg.exe

Use Windows line endings (CRLF) on Windows machines.
