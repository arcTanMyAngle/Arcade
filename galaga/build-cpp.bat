@echo off
REM Build the C++ / raylib Galaga with MSVC.
REM Loads the Visual Studio 2022 build environment so cl.exe is on PATH,
REM then configures + builds the Release executable into cpp\build\Release\.

setlocal
set "SCRIPT_DIR=%~dp0"

REM Locate the VS install (BuildTools or Community) via vswhere.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH (
    echo ERROR: could not find a Visual Studio install via vswhere.
    exit /b 1
)

call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 ( echo ERROR: vcvars64 failed & exit /b 1 )

cmake -S "%SCRIPT_DIR%cpp" -B "%SCRIPT_DIR%cpp\build" -G "Visual Studio 17 2022" -A x64
if errorlevel 1 ( echo ERROR: cmake configure failed & exit /b 1 )

cmake --build "%SCRIPT_DIR%cpp\build" --config Release
if errorlevel 1 ( echo ERROR: build failed & exit /b 1 )

echo.
echo Built: %SCRIPT_DIR%cpp\build\Release\galaga_cpp.exe
endlocal
