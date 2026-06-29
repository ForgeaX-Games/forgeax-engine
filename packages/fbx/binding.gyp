{
  'targets': [{
    'target_name': 'fbx_binding',
    'sources': ['src/native/binding.cc'],
    'include_dirs': [
      "<!(node -e \"console.log(require('node-addon-api').include.replace(/\\\"/g,''))\")",
      "<!(echo \"${FBX_SDK_ROOT:-$HOME/.local/fbxsdk/current}/include\")",
    ],
    'libraries': [
      "<!(echo \"${FBX_SDK_ROOT:-$HOME/.local/fbxsdk/current}/lib/clang/release/libfbxsdk.a\")",
      '-framework CoreFoundation', '-framework Foundation',
      '-liconv', '-lz', '-lxml2',
    ],
    'cflags_cc': ['-std=c++17', '-fexceptions'],
    'xcode_settings': {
      'CLANG_CXX_LANGUAGE_STANDARD': 'c++17',
      'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
      'OTHER_CFLAGS': ['-fexceptions'],
    },
    'defines': ['NAPI_DISABLE_CPP_EXCEPTIONS'],
  }],
}