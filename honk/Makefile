#
# OpenWrt package: honk (https://github.com/daeuniverse/honk)
#
# The sources are expected next to this Makefile in ./src, which is what the
# GitHub workflow checks out:
#
#   git clone https://github.com/daeuniverse/honk src
#
# Apart from the embedded dashboard (downloaded as a release archive, never
# compiled here), nothing is fetched while building. build.sh downloads the
# doona UI pinned in .github/ci/pins.env, builds the eBPF object with the
# nightly toolchain pinned in crates/honk-ebpf/rust-toolchain.toml, compiles
# honk-core with the crate's own pinned stable toolchain, and uses the OpenWrt
# cross gcc/g++ of the SDK (TARGET_CROSS) for BoringSSL, SQLite and the final
# link. HONK_VERSION is the package version (0.1.0_beta4, apk spells the beta
# pre-release with "_beta") and HONK_GIT_TAG the upstream tag the sources come
# from (v0.1.0-beta.4), which is the version honk's build script embeds.
#
# The binary is built with the full feature set: the crate defaults
# (clash-api, mimalloc, rprx) plus ebpf and native-ui. native-ui embeds the
# pinned doona dashboard at build time and implies native-api.
#
# The package also installs an OpenWrt procd init script (files/honk.init), its
# UCI configuration (files/honk.config) and a minimal /etc/honk/config.dae with
# the embedded UI enabled on loopback. The service is disabled by default;
# enable it in /etc/config/honk after adding nodes and routing rules.
#
# This file is free software, licensed under the GNU General Public License v3
# or later.

# $(CURDIR) points at the buildroot root, and $(MAKEFILE_LIST) grows with every
# included file, so the package directory has to be resolved before the first
# include. abspath keeps it valid when a recipe runs from another directory.
PKG_DIR:=$(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

include $(TOPDIR)/rules.mk

PKG_NAME:=honk
PKG_VERSION:=$(if $(HONK_VERSION),$(HONK_VERSION),0.1.0_beta4)
PKG_RELEASE:=3

# Upstream release the sources are checked out from. honk's build script derives
# the version it embeds from the tag in GITHUB_REF, so build.sh exports it.
HONK_GIT_TAG:=$(if $(HONK_GIT_TAG),$(HONK_GIT_TAG),v0.1.0-beta.4)

PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

include $(INCLUDE_DIR)/package.mk

HONK_SRC:=$(PKG_DIR)/src

define Package/honk
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=eBPF transparent proxy engine (honk-core) with embedded UI
  URL:=https://github.com/daeuniverse/honk
  LICENSE:=GPL-3.0-only
  # honk-core is linked against the musl and the C++ runtime of OpenWrt. Its
  # eBPF datapath needs TC-bpf and a veth pair plus the daens namespace, and
  # its NFQUEUE staging uses nftables queue expressions over nfnetlink_queue.
  # Its BTF comes from vmlinux-btf, as for dae. The geo packages ship the dat
  # files; this package links them into /usr/share/honk, which honk searches
  # before the dae locations.
  DEPENDS:=+libstdcpp +kmod-veth +kmod-sched-core +kmod-sched-bpf \
           +kmod-nft-core +kmod-nft-queue +kmod-nfnetlink-queue \
           +kmod-nf-conntrack +vmlinux-btf +v2ray-geoip +v2ray-geosite
endef

define Package/honk/description
 honk is an eBPF transparent proxy engine. honk-core embeds its eBPF object and
 needs kernel BTF for CO-RE relocations, which vmlinux-btf provides. This
 build enables the Clash API, the native API and the embedded doona dashboard
 (native-ui), which is served at /ui on the native API listener.
endef

define Build/Prepare
	@if [ ! -d "$(HONK_SRC)" ]; then \
		echo "honk: the source tree is missing at $(HONK_SRC)"; \
		echo "honk: run 'git clone https://github.com/daeuniverse/honk src' in $(PKG_DIR)"; \
		exit 1; \
	fi
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) $(HONK_SRC)/. $(PKG_BUILD_DIR)/
endef

define Build/Compile
	HONK_SRC="$(PKG_BUILD_DIR)" \
	HONK_VERSION="$(PKG_VERSION)" \
	HONK_GIT_TAG="$(HONK_GIT_TAG)" \
	HONK_ARCH_PACKAGES="$(ARCH_PACKAGES)" \
	OPENWRT_CC="$(TARGET_CROSS)gcc" \
	OPENWRT_CXX="$(TARGET_CROSS)g++" \
	sh "$(PKG_DIR)/build.sh"
endef

define Package/honk/conffiles
/etc/config/honk
/etc/honk/config.dae
endef

define Package/honk/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/honk-core $(1)/usr/bin/honk-core
	$(INSTALL_DIR) $(1)/usr/share/licenses/honk
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/LICENSE $(1)/usr/share/licenses/honk/LICENSE
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_DIR)/files/honk.init $(1)/etc/init.d/honk
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(PKG_DIR)/files/honk.config $(1)/etc/config/honk
	$(INSTALL_DIR) $(1)/etc/honk
	$(INSTALL_CONF) $(PKG_DIR)/files/config.dae $(1)/etc/honk/config.dae
	# v2ray-geoip/geosite install the files under /usr/share/v2ray. honk's
	# find_dat looks in /usr/share/honk before /usr/share/dae.
	$(INSTALL_DIR) $(1)/usr/share/honk
	$(LN) ../v2ray/geoip.dat $(1)/usr/share/honk/geoip.dat
	$(LN) ../v2ray/geosite.dat $(1)/usr/share/honk/geosite.dat
endef

$(eval $(call BuildPackage,honk))
