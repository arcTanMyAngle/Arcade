cmake_minimum_required(VERSION 3.16)
project(galaga_cpp CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Pull raylib reproducibly from source (built once, then cached in build/).
include(FetchContent)
set(FETCHCONTENT_QUIET OFF)
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_GAMES    OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    raylib
    GIT_REPOSITORY https://github.com/raysan5/raylib.git
    GIT_TAG        5.5
)
FetchContent_MakeAvailable(raylib)

add_executable(galaga_cpp
    src/main.cpp
    src/game.cpp
)
target_include_directories(galaga_cpp PRIVATE src)
target_link_libraries(galaga_cpp PRIVATE raylib)

if (MSVC)
    target_compile_options(galaga_cpp PRIVATE /O2 /fp:fast)
endif()
