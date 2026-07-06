@echo off
REM Build + run the Rust / raylib Galaga.
REM raylib-sys generates bindings with bindgen, which needs libclang (LLVM).
REM LLVM isn't on PATH here, so point LIBCLANG_PATH at the standard install.

setlocal
set "SCRIPT_DIR=%~dp0"

if not defined LIBCLANG_PATH (
    if exist "C:\Program Files\LLVM\bin\libclang.dll" (
        set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
    )
)
if not defined LIBCLANG_PATH (
    echo ERROR: libclang not found. Install LLVM ^(winget install LLVM.LLVM^)
    echo        or set LIBCLANG_PATH to the folder containing libclang.dll.
    exit /b 1
)

cargo run --release --manifest-path "%SCRIPT_DIR%rust\Cargo.toml"
endlocal
