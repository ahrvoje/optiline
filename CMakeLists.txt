# Optiline native + WebAssembly build (PROJECT_SPECIFICATION.md §6.1, §6.4).
#
# Native (MSVC v143, Windows x64):
#   cmake -S . -B build/native -G Ninja -DCMAKE_C_COMPILER=cl
#   cmake --build build/native
#   ctest --test-dir build/native            # test suite (do not run implicitly)
#
# Browser WASM (WASI SDK 33.0, pinned under tools/):
#   cmake -S . -B build/wasm -G Ninja -DOPTILINE_WASM=ON
#   cmake --build build/wasm
cmake_minimum_required(VERSION 3.31)
option(OPTILINE_WASM "Build the browser WASIp1 reactors instead of native targets" OFF)
set(OPTILINE_WASI_SDK "${CMAKE_SOURCE_DIR}/tools/wasi-sdk-33.0-x86_64-windows")

# A compiler and target platform must be selected before project().
if(OPTILINE_WASM)
  set(OPTILINE_WASI_SDK "${CMAKE_CURRENT_SOURCE_DIR}/tools/wasi-sdk-33.0-x86_64-windows")
  if(NOT EXISTS "${OPTILINE_WASI_SDK}/bin/clang.exe")
    message(FATAL_ERROR "Pinned WASI SDK missing. Run tools/bootstrap-wasi.ps1 first.")
  endif()
  set(CMAKE_C_COMPILER "${OPTILINE_WASI_SDK}/bin/clang.exe" CACHE FILEPATH "" FORCE)
  set(CMAKE_SYSTEM_NAME Generic CACHE STRING "" FORCE)
endif()

project(optiline C)

set(OPTILINE_WASI_SDK "${CMAKE_SOURCE_DIR}/tools/wasi-sdk-33.0-x86_64-windows")

# ---------------------------------------------------------------------------
# Shared authoritative C99 core (§6.4). op_playback_inverse.c is EXCLUDED:
# it may only be linked by the playback reactor and playback tests (§8.8).
# ---------------------------------------------------------------------------
set(OPTILINE_CORE_SOURCES
  c/src/op_math.c
  c/src/op_interval.c
  c/src/op_span.c
  c/src/op_regularity.c
  c/src/op_offset.c
  c/src/op_construction.c
  c/src/op_qr.c
  c/src/op_seed.c
  c/src/op_edit.c
  c/src/op_selfint.c
  c/src/op_containment.c
  c/src/op_dynamics.c
  c/src/op_philox.c
  c/src/op_cpu_search.c
  c/src/op_track_compile.c
  c/src/op_cells.c
  c/src/op_canonical.c
  c/src/op_sha256.c
)

set(OPTILINE_PLAYBACK_SOURCES
  c/src/op_playback_inverse.c
)

# Minimal evaluation subset the playback reactor needs besides the inverse.
set(OPTILINE_EVAL_SOURCES
  c/src/op_math.c
  c/src/op_span.c
)

include_directories(c/include)

if(OPTILINE_WASM)
  # -------------------------------------------------------------------------
  # Browser reactors: WASI SDK 33.0 Clang, wasm32-wasip1 (§6.1, §6.4).
  # -------------------------------------------------------------------------
  set(CMAKE_EXECUTABLE_SUFFIX ".wasm")

  set(WASM_FLAGS
    --target=wasm32-wasip1
    -O3 -std=c99 -pedantic-errors -fno-fast-math -ffp-contract=off
    -Wall -Wextra -Werror
  )
  # Fixed maximum memory; no growth during optimization or playback (§6.4).
  set(WASM_LINK_FLAGS
    --target=wasm32-wasip1 -mexec-model=reactor
    -Wl,--initial-memory=134217728,--max-memory=134217728
    -Wl,-z,stack-size=8388608
    -Wl,--export=_initialize
  )

  add_executable(optiline_certifier
    ${OPTILINE_CORE_SOURCES}
    c/wasm/certifier_exports.c
  )
  target_compile_options(optiline_certifier PRIVATE ${WASM_FLAGS})
  target_link_options(optiline_certifier PRIVATE ${WASM_LINK_FLAGS})

  add_executable(optiline_playback
    ${OPTILINE_EVAL_SOURCES}
    ${OPTILINE_PLAYBACK_SOURCES}
    c/wasm/playback_exports.c
  )
  target_compile_options(optiline_playback PRIVATE ${WASM_FLAGS})
  target_link_options(optiline_playback PRIVATE ${WASM_LINK_FLAGS})

  # Vite copies public/ verbatim into the static deployment.
  foreach(reactor optiline_certifier optiline_playback)
    add_custom_command(TARGET ${reactor} POST_BUILD
      COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_SOURCE_DIR}/public"
      COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "$<TARGET_FILE:${reactor}>" "${CMAKE_SOURCE_DIR}/public/$<TARGET_FILE_NAME:${reactor}>")
  endforeach()

else()
  # -------------------------------------------------------------------------
  # Native reference build: MSVC /TC /std:c17, C99 subset (§6.1).
  # -------------------------------------------------------------------------
  if(MSVC)
    set(OPTILINE_C_FLAGS /O2 /TC /std:c17 /fp:strict /W4 /WX)
    # Link map for the §24.1 forbidden-symbol inspection.
    add_link_options(/MAP)
  else()
    # Non-MSVC hosts (CI cross-checks only); keep the same strictness.
    set(OPTILINE_C_FLAGS -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror
        -fno-fast-math -ffp-contract=off)
  endif()

  add_library(optiline_core STATIC ${OPTILINE_CORE_SOURCES})
  target_compile_options(optiline_core PRIVATE ${OPTILINE_C_FLAGS})

  add_library(optiline_playback_core STATIC
    ${OPTILINE_PLAYBACK_SOURCES})
  target_compile_options(optiline_playback_core PRIVATE ${OPTILINE_C_FLAGS})

  # Native track compiler (§6.4 c/tools).
  add_executable(optiline_track_compiler c/tools/track_compiler_main.c)
  target_compile_options(optiline_track_compiler PRIVATE ${OPTILINE_C_FLAGS})
  target_link_libraries(optiline_track_compiler PRIVATE optiline_core)

  # Fixture comparison tool (oracle parity, §24.3).
  add_executable(optiline_fixture_check c/tools/fixture_check_main.c)
  target_compile_options(optiline_fixture_check PRIVATE ${OPTILINE_C_FLAGS})
  target_link_libraries(optiline_fixture_check PRIVATE optiline_core)

  # -------------------------------------------------------------------------
  # Tests (§24.1–§24.7). optiline_tests MUST NOT link the playback inverse;
  # optiline_playback_tests is the only test binary that links it.
  # -------------------------------------------------------------------------
  enable_testing()

  set(OPTILINE_TEST_SOURCES
    c/tests/test_runner.c
    c/tests/test_math.c
    c/tests/test_interval.c
    c/tests/test_span.c
    c/tests/test_gram.c
    c/tests/test_regularity.c
    c/tests/test_offset.c
    c/tests/test_selfint.c
    c/tests/test_containment.c
    c/tests/test_dynamics.c
    c/tests/test_construction.c
    c/tests/test_optimizer.c
    c/tests/test_track.c
    c/tests/test_abi.c
    c/tests/test_canonical.c
    c/tests/test_oracle.c
  )

  add_executable(optiline_tests ${OPTILINE_TEST_SOURCES})
  target_compile_options(optiline_tests PRIVATE ${OPTILINE_C_FLAGS})
  target_compile_definitions(optiline_tests PRIVATE
    OPTILINE_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/fixtures")
  target_link_libraries(optiline_tests PRIVATE optiline_core)
  add_test(NAME core_tests COMMAND optiline_tests)

  add_executable(optiline_playback_tests
    c/tests/test_runner.c
    c/tests/test_playback.c
  )
  target_compile_options(optiline_playback_tests PRIVATE ${OPTILINE_C_FLAGS})
  target_compile_definitions(optiline_playback_tests PRIVATE
    OPTILINE_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/fixtures"
    OPTILINE_PLAYBACK_TESTS=1)
  target_link_libraries(optiline_playback_tests PRIVATE
    optiline_playback_core optiline_core)
  add_test(NAME playback_tests COMMAND optiline_playback_tests)

  # §24.1 link-map inspection: certifier artifacts must not contain the
  # inverse symbols; the playback module must contain them.
  add_test(NAME forbidden_symbols
    COMMAND "${CMAKE_COMMAND}"
      -DMAP_DIR=${CMAKE_BINARY_DIR}
      -P "${CMAKE_SOURCE_DIR}/c/tests/check_link_map.cmake")
endif()
