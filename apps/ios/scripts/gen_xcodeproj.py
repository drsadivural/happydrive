#!/usr/bin/env python3
"""HappyDrive.xcodeproj を生成する（XcodeGen なしで Xcode から開けるようにするため）。

- HappyDrive/ と HappyDriveUITests/ 以下のファイルを走査し、全ソース・リソースを参照する project.pbxproj を出力
- ローカル Swift パッケージ HappyDriveCore をフォルダ参照 + XCSwiftPackageProductDependency で接続
- リモート Swift パッケージ（WebRTC：音声アシスタント用、アプリ本体のみ）を XCRemoteSwiftPackageReference で接続
- オブジェクト ID はパスから決定的に生成（再実行しても差分が出ない）
- Debug 用 Info-Debug.plist（localhost のみ HTTP 許可）を Info.plist から生成
- 共有スキーム HappyDrive.xcscheme を出力

使い方: python3 apps/ios/scripts/gen_xcodeproj.py
同等の XcodeGen 定義は apps/ios/project.yml。
"""
from __future__ import annotations

import hashlib
import os
import plistlib
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # apps/ios
PROJECT = os.path.join(ROOT, "HappyDrive.xcodeproj")
APP_DIR = "HappyDrive"
UITEST_DIR = "HappyDriveUITests"
PACKAGE_DIR = "HappyDriveCore"
CONFIG_DIR = "Config"

# アプリ本体だけが使うリモート Swift パッケージ（HappyDriveCore には入れない＝Linux のテストに影響しない）
# (識別名, リポジトリ URL, 最小バージョン, プロダクト名)
REMOTE_PACKAGES = [
    # WebRTC（Google libwebrtc のバイナリ xcframework 配布。OpenAI Realtime への音声接続に使用）
    ("WebRTC", "https://github.com/stasel/WebRTC", "153.0.0", "WebRTC"),
]

# Info.plist 等はビルド設定で参照するためリソースに含めない
NON_RESOURCE_FILES = {"Info.plist", "Info-Debug.plist", "HappyDrive.entitlements"}
IGNORED = {".DS_Store"}


def oid(*parts: str) -> str:
    return hashlib.md5("::".join(parts).encode("utf-8")).hexdigest()[:24].upper()


def quote(s: str) -> str:
    safe = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$./")
    if s and all(c in safe for c in s):
        return s
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def file_type(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    return {
        ".swift": "sourcecode.swift",
        ".xcassets": "folder.assetcatalog",
        ".ttf": "file",
        ".otf": "file",
        ".txt": "text",
        ".xcstrings": "text.json.xcstrings",
        ".strings": "text.plist.strings",
        ".xcprivacy": "text.xml",
        ".plist": "text.plist.xml",
        ".entitlements": "text.plist.entitlements",
        ".xcconfig": "text.xcconfig",
        ".md": "net.daringfireball.markdown",
        ".json": "text.json",
    }.get(ext, "file")


def write_debug_info_plist() -> None:
    src = os.path.join(ROOT, APP_DIR, "Supporting", "Info.plist")
    with open(src, "rb") as f:
        info = plistlib.load(f)
    info["NSAppTransportSecurity"] = {
        # Debug ビルドのみ: ローカル API（http://localhost:8080）への接続を許可
        "NSAllowsLocalNetworking": True,
        "NSExceptionDomains": {"localhost": {"NSExceptionAllowsInsecureHTTPLoads": True}},
    }
    dst = os.path.join(ROOT, APP_DIR, "Supporting", "Info-Debug.plist")
    with open(dst, "wb") as f:
        plistlib.dump(info, f, fmt=plistlib.FMT_XML, sort_keys=True)


class Group:
    def __init__(self, name: str, path: str | None, gid: str):
        self.name = name
        self.path = path
        self.id = gid
        self.children: list[str] = []


def main() -> int:
    write_debug_info_plist()

    objects: dict[str, str] = {}

    def add(obj_id: str, body: str) -> None:
        objects[obj_id] = body

    groups: dict[str, Group] = {}
    file_refs: dict[str, str] = {}  # relpath -> id
    app_sources: list[str] = []
    app_resources: list[str] = []
    test_sources: list[str] = []

    def group_for(rel_dir: str) -> Group:
        if rel_dir in groups:
            return groups[rel_dir]
        parent_rel, name = os.path.split(rel_dir)
        g = Group(name, name, oid("group", rel_dir))
        groups[rel_dir] = g
        if parent_rel:
            group_for(parent_rel).children.append(g.id)
        return g

    def add_file(rel: str, ftype: str | None = None) -> str:
        fid = oid("file", rel)
        name = os.path.basename(rel)
        t = ftype or file_type(name)
        add(fid, f"{{isa = PBXFileReference; lastKnownFileType = {t}; path = {quote(name)}; sourceTree = \"<group>\"; }};")
        file_refs[rel] = fid
        return fid

    variant_groups: dict[str, str] = {}  # base name -> variant group id

    def walk(top: str, kind: str) -> None:
        for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, top)):
            dirnames.sort()
            rel_dir = os.path.relpath(dirpath, ROOT)
            g = group_for(rel_dir)
            # .xcassets はフォルダごと 1 参照（中身は走査しない）
            for d in list(dirnames):
                if d.endswith(".xcassets"):
                    rel = os.path.join(rel_dir, d)
                    fid = add_file(rel)
                    g.children.append(fid)
                    app_resources.append(fid)
                    dirnames.remove(d)
                elif d.endswith(".lproj"):
                    # ローカライズ済みリソースは PBXVariantGroup にまとめる
                    lang = d[:-len(".lproj")]
                    for fn in sorted(os.listdir(os.path.join(dirpath, d))):
                        if fn in IGNORED:
                            continue
                        vg_key = os.path.join(rel_dir, fn)
                        rel = os.path.join(rel_dir, d, fn)
                        fid = oid("file", rel)
                        add(fid, f"{{isa = PBXFileReference; lastKnownFileType = {file_type(fn)}; name = {quote(lang)}; path = {quote(d + '/' + fn)}; sourceTree = \"<group>\"; }};")
                        if vg_key not in variant_groups:
                            vgid = oid("variant", vg_key)
                            variant_groups[vg_key] = vgid
                            objects[vgid] = ("VARIANT", fn, [])  # type: ignore[assignment]
                            g.children.append(vgid)
                            app_resources.append(vgid)
                        objects[variant_groups[vg_key]][2].append(fid)  # type: ignore[index]
                    dirnames.remove(d)
            for fn in sorted(filenames):
                if fn in IGNORED:
                    continue
                rel = os.path.join(rel_dir, fn)
                fid = add_file(rel)
                g.children.append(fid)
                if fn.endswith(".swift"):
                    (app_sources if kind == "app" else test_sources).append(fid)
                elif kind == "app" and fn not in NON_RESOURCE_FILES:
                    app_resources.append(fid)

    walk(APP_DIR, "app")
    walk(UITEST_DIR, "test")

    # Config（xcconfig）
    cfg_group = group_for(CONFIG_DIR)
    for fn in sorted(os.listdir(os.path.join(ROOT, CONFIG_DIR))):
        if fn.endswith(".xcconfig"):
            cfg_group.children.append(add_file(os.path.join(CONFIG_DIR, fn)))

    # ローカルパッケージ（フォルダ参照。Xcode が Package.swift を検出してローカルパッケージとして扱う）
    pkg_ref = oid("package-folder", PACKAGE_DIR)
    add(pkg_ref, f"{{isa = PBXFileReference; lastKnownFileType = folder; path = {PACKAGE_DIR}; sourceTree = SOURCE_ROOT; }};")
    packages_group = Group("Packages", None, oid("group", "Packages"))
    packages_group.children.append(pkg_ref)

    readme_ref = add_file("README.md")

    # 生成物
    app_product = oid("product", "HappyDrive.app")
    test_product = oid("product", "HappyDriveUITests.xctest")
    add(app_product, "{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = HappyDrive.app; sourceTree = BUILT_PRODUCTS_DIR; };")
    add(test_product, "{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = HappyDriveUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };")
    products_group = Group("Products", None, oid("group", "Products"))
    products_group.children += [app_product, test_product]

    main_group = Group("", None, oid("group", "<main>"))
    main_group.children += [readme_ref, groups[APP_DIR].id, groups[UITEST_DIR].id, groups[CONFIG_DIR].id, packages_group.id, products_group.id]

    # ビルドファイル
    def build_files(ids: list[str], phase: str) -> list[str]:
        out = []
        for fid in ids:
            bid = oid("buildfile", phase, fid)
            add(bid, f"{{isa = PBXBuildFile; fileRef = {fid}; }};")
            out.append(bid)
        return out

    app_source_bfs = build_files(app_sources, "app-sources")
    app_resource_bfs = build_files(app_resources, "app-resources")
    test_source_bfs = build_files(test_sources, "test-sources")

    core_dep = oid("package-product", "HappyDriveCore")
    add(core_dep, "{isa = XCSwiftPackageProductDependency; productName = HappyDriveCore; };")
    core_bf = oid("buildfile", "frameworks", core_dep)
    add(core_bf, f"{{isa = PBXBuildFile; productRef = {core_dep}; }};")

    remote_refs: list[str] = []
    remote_deps: list[str] = []
    remote_bfs: list[str] = []
    for ident, url, minimum, product in REMOTE_PACKAGES:
        ref = oid("remote-package", ident)
        add(ref, (
            f"{{isa = XCRemoteSwiftPackageReference; repositoryURL = {quote(url)}; "
            f"requirement = {{ kind = upToNextMajorVersion; minimumVersion = {minimum}; }}; }};"
        ))
        dep_id = oid("package-product", ident, product)
        add(dep_id, f"{{isa = XCSwiftPackageProductDependency; package = {ref}; productName = {product}; }};")
        bf = oid("buildfile", "frameworks", dep_id)
        add(bf, f"{{isa = PBXBuildFile; productRef = {dep_id}; }};")
        remote_refs.append(ref)
        remote_deps.append(dep_id)
        remote_bfs.append(bf)

    # ビルドフェーズ
    def phase(isa: str, key: str, files: list[str]) -> str:
        pid = oid("phase", key)
        add(pid, f"{{isa = {isa}; buildActionMask = 2147483647; files = ({', '.join(files)}{', ' if files else ''}); runOnlyForDeploymentPostprocessing = 0; }};")
        return pid

    app_src_phase = phase("PBXSourcesBuildPhase", "app-sources", app_source_bfs)
    app_res_phase = phase("PBXResourcesBuildPhase", "app-resources", app_resource_bfs)
    app_fw_phase = phase("PBXFrameworksBuildPhase", "app-frameworks", [core_bf] + remote_bfs)
    test_src_phase = phase("PBXSourcesBuildPhase", "test-sources", test_source_bfs)
    test_res_phase = phase("PBXResourcesBuildPhase", "test-resources", [])
    test_fw_phase = phase("PBXFrameworksBuildPhase", "test-frameworks", [])

    # ビルド設定
    xc_debug = file_refs[os.path.join(CONFIG_DIR, "Debug.xcconfig")]
    xc_release = file_refs[os.path.join(CONFIG_DIR, "Release.xcconfig")]

    def settings(d: dict[str, object]) -> str:
        parts = []
        for k in sorted(d):
            v = d[k]
            if isinstance(v, list):
                parts.append(f"{k} = ({', '.join(quote(x) for x in v)}, );")
            else:
                parts.append(f"{k} = {quote(str(v))};")
        return " ".join(parts)

    project_common = {
        "ALWAYS_SEARCH_USER_PATHS": "NO",
        "CLANG_ENABLE_MODULES": "YES",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "COPY_PHASE_STRIP": "NO",
        "ENABLE_STRICT_OBJC_MSGSEND": "YES",
        "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
        "GCC_NO_COMMON_BLOCKS": "YES",
        "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
        "LOCALIZATION_PREFERS_STRING_CATALOGS": "YES",
        "SDKROOT": "iphoneos",
        "SWIFT_VERSION": "5.0",
    }
    project_debug = dict(project_common, **{
        "DEBUG_INFORMATION_FORMAT": "dwarf",
        "ENABLE_TESTABILITY": "YES",
        "GCC_OPTIMIZATION_LEVEL": "0",
        "ONLY_ACTIVE_ARCH": "YES",
        "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG $(inherited)",
        "SWIFT_OPTIMIZATION_LEVEL": "-Onone",
    })
    project_release = dict(project_common, **{
        "DEBUG_INFORMATION_FORMAT": "dwarf-with-dsym",
        "SWIFT_COMPILATION_MODE": "wholemodule",
        "SWIFT_OPTIMIZATION_LEVEL": "-O",
        "VALIDATE_PRODUCT": "YES",
    })
    app_common = {
        "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
        "ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME": "AccentColor",
        "DEVELOPMENT_ASSET_PATHS": '"HappyDrive/Preview Content"',
        "ENABLE_PREVIEWS": "YES",
        "GENERATE_INFOPLIST_FILE": "NO",
        "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"],
        "PRODUCT_NAME": "$(TARGET_NAME)",
        "SWIFT_EMIT_LOC_STRINGS": "YES",
    }
    test_common = {
        "CODE_SIGN_STYLE": "Automatic",
        "GENERATE_INFOPLIST_FILE": "YES",
        "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
        "PRODUCT_BUNDLE_IDENTIFIER": "jp.happydrive.driver.uitests",
        "PRODUCT_NAME": "$(TARGET_NAME)",
        "SWIFT_VERSION": "5.0",
        "TARGETED_DEVICE_FAMILY": "1",
        "TEST_TARGET_NAME": "HappyDrive",
    }

    def config(key: str, name: str, d: dict[str, object], base: str | None = None) -> str:
        cid = oid("config", key, name)
        base_line = f"baseConfigurationReference = {base}; " if base else ""
        add(cid, f"{{isa = XCBuildConfiguration; {base_line}buildSettings = {{ {settings(d)} }}; name = {name}; }};")
        return cid

    def config_list(key: str, ids: list[str]) -> str:
        lid = oid("configlist", key)
        add(lid, f"{{isa = XCConfigurationList; buildConfigurations = ({', '.join(ids)}, ); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; }};")
        return lid

    project_cfgs = config_list("project", [config("project", "Debug", project_debug), config("project", "Release", project_release)])
    app_cfgs = config_list("app", [config("app", "Debug", app_common, xc_debug), config("app", "Release", app_common, xc_release)])
    test_cfgs = config_list("test", [config("test", "Debug", test_common), config("test", "Release", test_common)])

    # ターゲット
    app_target = oid("target", "HappyDrive")
    test_target = oid("target", "HappyDriveUITests")
    proxy = oid("proxy", "uitests->app")
    project_id = oid("project", "HappyDrive")
    add(proxy, f"{{isa = PBXContainerItemProxy; containerPortal = {project_id}; proxyType = 1; remoteGlobalIDString = {app_target}; remoteInfo = HappyDrive; }};")
    dep = oid("dependency", "uitests->app")
    add(dep, f"{{isa = PBXTargetDependency; target = {app_target}; targetProxy = {proxy}; }};")

    add(app_target, (
        f"{{isa = PBXNativeTarget; buildConfigurationList = {app_cfgs}; buildPhases = ({app_src_phase}, {app_fw_phase}, {app_res_phase}, ); "
        f"buildRules = ( ); dependencies = ( ); name = HappyDrive; packageProductDependencies = ({', '.join([core_dep] + remote_deps)}, ); "
        f"productName = HappyDrive; productReference = {app_product}; productType = \"com.apple.product-type.application\"; }};"
    ))
    add(test_target, (
        f"{{isa = PBXNativeTarget; buildConfigurationList = {test_cfgs}; buildPhases = ({test_src_phase}, {test_fw_phase}, {test_res_phase}, ); "
        f"buildRules = ( ); dependencies = ({dep}, ); name = HappyDriveUITests; productName = HappyDriveUITests; "
        f"productReference = {test_product}; productType = \"com.apple.product-type.bundle.ui-testing\"; }};"
    ))

    add(project_id, (
        "{isa = PBXProject; attributes = { BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 1600; LastUpgradeCheck = 1600; "
        f"TargetAttributes = {{ {app_target} = {{ CreatedOnToolsVersion = 16.0; }}; {test_target} = {{ CreatedOnToolsVersion = 16.0; TestTargetID = {app_target}; }}; }}; }}; "
        f"buildConfigurationList = {project_cfgs}; compatibilityVersion = \"Xcode 14.0\"; developmentRegion = ja; hasScannedForEncodings = 0; "
        f"knownRegions = (ja, Base, ); mainGroup = {main_group.id}; "
        f"packageReferences = ({''.join(r + ', ' for r in remote_refs)}); "
        f"productRefGroup = {products_group.id}; projectDirPath = \"\"; projectRoot = \"\"; "
        f"targets = ({app_target}, {test_target}, ); }};"
    ))

    # グループ
    all_groups = list(groups.values()) + [packages_group, products_group, main_group]
    for g in all_groups:
        children = ", ".join(g.children)
        if g is main_group:
            add(g.id, f"{{isa = PBXGroup; children = ({children}, ); sourceTree = \"<group>\"; }};")
        elif g.path is None:
            add(g.id, f"{{isa = PBXGroup; children = ({children}, ); name = {quote(g.name)}; sourceTree = \"<group>\"; }};")
        else:
            add(g.id, f"{{isa = PBXGroup; children = ({children}{', ' if children else ''}); path = {quote(g.path)}; sourceTree = \"<group>\"; }};")

    # バリアントグループ（InfoPlist.strings 等）
    for key, vgid in variant_groups.items():
        _, name, kids = objects[vgid]  # type: ignore[misc]
        objects[vgid] = f"{{isa = PBXVariantGroup; children = ({', '.join(kids)}, ); name = {quote(name)}; sourceTree = \"<group>\"; }};"

    # 出力（isa ごとにセクション分け）
    def isa_of(body: str) -> str:
        return body.split("isa = ", 1)[1].split(";", 1)[0]

    sections: dict[str, list[tuple[str, str]]] = {}
    for k, body in objects.items():
        sections.setdefault(isa_of(body), []).append((k, body))

    lines = ["// !$*UTF8*$!", "{", "\tarchiveVersion = 1;", "\tclasses = {", "\t};", "\tobjectVersion = 56;", "\tobjects = {", ""]
    for isa in sorted(sections):
        lines.append(f"/* Begin {isa} section */")
        for k, body in sorted(sections[isa]):
            lines.append(f"\t\t{k} = {body}")
        lines.append(f"/* End {isa} section */")
        lines.append("")
    lines += ["\t};", f"\trootObject = {project_id};", "}", ""]

    os.makedirs(PROJECT, exist_ok=True)
    with open(os.path.join(PROJECT, "project.pbxproj"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    ws = os.path.join(PROJECT, "project.xcworkspace")
    os.makedirs(ws, exist_ok=True)
    with open(os.path.join(ws, "contents.xcworkspacedata"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<Workspace\n   version = "1.0">\n   <FileRef\n      location = "self:">\n   </FileRef>\n</Workspace>\n')

    write_scheme(app_target, test_target)
    print(f"generated {os.path.relpath(PROJECT, ROOT)}: {len(app_sources)} app sources, {len(app_resources)} resources, {len(test_sources)} UI test sources, {len(objects)} objects")
    return 0


def write_scheme(app_target: str, test_target: str) -> None:
    d = os.path.join(PROJECT, "xcshareddata", "xcschemes")
    os.makedirs(d, exist_ok=True)
    app_ref = f'''<BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "{app_target}"
               BuildableName = "HappyDrive.app"
               BlueprintName = "HappyDrive"
               ReferencedContainer = "container:HappyDrive.xcodeproj">
            </BuildableReference>'''
    test_ref = f'''<BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "{test_target}"
               BuildableName = "HappyDriveUITests.xctest"
               BlueprintName = "HappyDriveUITests"
               ReferencedContainer = "container:HappyDrive.xcodeproj">
            </BuildableReference>'''
    scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            {app_ref}
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "NO">
      <Testables>
         <TestableReference
            skipped = "NO">
            {test_ref}
         </TestableReference>
      </Testables>
      <EnvironmentVariables>
         <EnvironmentVariable
            key = "HD_UITEST_API"
            value = "http://localhost:8080/v1"
            isEnabled = "NO">
         </EnvironmentVariable>
         <EnvironmentVariable
            key = "HD_UITEST_PHONE"
            value = ""
            isEnabled = "NO">
         </EnvironmentVariable>
         <EnvironmentVariable
            key = "HD_UITEST_OTP"
            value = ""
            isEnabled = "NO">
         </EnvironmentVariable>
      </EnvironmentVariables>
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         {app_ref}
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         {app_ref}
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
'''
    with open(os.path.join(d, "HappyDrive.xcscheme"), "w", encoding="utf-8") as f:
        f.write(scheme)


if __name__ == "__main__":
    sys.exit(main())
