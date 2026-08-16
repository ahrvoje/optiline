# §24.1 forbidden-symbol inspection.
# The certifier-side artifacts (optiline_core library members linked into
# optiline_tests / track compiler) must not contain the playback inverse
# symbols; the playback artifacts must contain them.
#
# Usage: cmake -DMAP_DIR=<build dir> -P check_link_map.cmake

set(FORBIDDEN op_arc_length_inverse op_point_at_distance op_playback_build_lut)

# Locate the MSVC .map files produced with /MAP.
file(GLOB MAPS "${MAP_DIR}/*.map" "${MAP_DIR}/**/*.map")

set(FAILED FALSE)
foreach(map ${MAPS})
  get_filename_component(name "${map}" NAME_WE)
  file(READ "${map}" contents)
  if(name MATCHES "playback")
    foreach(sym ${FORBIDDEN})
      if(NOT contents MATCHES "${sym}")
        message(WARNING "playback artifact ${name} is missing expected symbol ${sym}")
        set(FAILED TRUE)
      endif()
    endforeach()
  else()
    foreach(sym ${FORBIDDEN})
      if(contents MATCHES "${sym}")
        message(SEND_ERROR
          "certifier artifact ${name} contains forbidden playback symbol ${sym} (§8.8, §24.1)")
        set(FAILED TRUE)
      endif()
    endforeach()
  endif()
endforeach()

if(FAILED)
  message(FATAL_ERROR "forbidden-symbol inspection failed")
endif()
message(STATUS "forbidden-symbol inspection passed")
