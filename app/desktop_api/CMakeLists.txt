cmake_minimum_required(VERSION 3.20)

set(AUDIOCPP_API_SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/audiocpp_api.cpp
    ${CMAKE_SOURCE_DIR}/external/whisper.cpp/src/whisper.cpp
)

add_library(audiocpp_engine SHARED
    ${AUDIOCPP_API_SOURCES}
)

target_include_directories(audiocpp_engine PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/external/whisper.cpp/include
    ${CMAKE_SOURCE_DIR}/external/whisper.cpp/src
    ${CMAKE_SOURCE_DIR}/external/ggml/include
)

target_compile_definitions(audiocpp_engine PRIVATE
    AUDIOCPP_API_EXPORT
    WHISPER_VERSION="1.7.6"
)

target_link_libraries(audiocpp_engine PRIVATE
    engine_runtime
)

if (MSVC)
    target_compile_options(audiocpp_engine PRIVATE /W4)
else()
    target_compile_options(audiocpp_engine PRIVATE -Wall -Wextra -Wpedantic)
endif()

set_target_properties(audiocpp_engine PROPERTIES
    OUTPUT_NAME audiocpp_engine
    PREFIX ""
)

if (MSVC)
    set_target_properties(audiocpp_engine PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}
        LIBRARY_OUTPUT_DIRECTORY ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}
    )
endif()
