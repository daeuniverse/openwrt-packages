#
# OpenWrt package: dae (https://github.com/daeuniverse/dae)
#
# The sources are expected next to this Makefile in ./src, which is what the
# GitHub workflow checks out:
#
#   git clone --recurse-submodules https://github.com/daeuniverse/dae src
#
# Nothing is downloaded while building: dae's own Makefile drives the build
# (pure Go, CGO_ENABLED=0, clang for the bpf2go objects, see build.sh), and the
# version the binary reports is passed in as DAE_VERSION (the release tag
# without its leading "v", e.g. 2.1.1).
#
# The package also installs an OpenWrt procd init script (files/dae.init), its
# UCI configuration (files/dae.config) and the upstream example.dae as the
# initial /etc/dae/config.dae. The service is disabled by default; run
# /etc/init.d/dae enable and start it after adapting the configuration to the
# device. files/dae.uci-defaults moves the boot setting of earlier versions
# (UCI option enabled) to that rc.d link.
#
# This file is free software, licensed under the GNU General Public License v3
# or later.

# $(CURDIR) points at the buildroot root, and $(MAKEFILE_LIST) grows with every
# included file, so the package directory has to be resolved before the first
# include. abspath keeps it valid when a recipe runs from another directory.
PKG_DIR:=$(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

include $(TOPDIR)/rules.mk

PKG_NAME:=dae
PKG_VERSION:=$(if $(DAE_VERSION),$(DAE_VERSION),2.1.1)
PKG_RELEASE:=5

PKG_LICENSE:=AGPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

include $(INCLUDE_DIR)/package.mk

DAE_SRC:=$(PKG_DIR)/src

# clang compiles the eBPF objects that bpf2go embeds, llvm-strip strips the
# binary. The Go toolchain (>= the version in go.mod) has to be on PATH.
DAE_CLANG:=$(shell command -v clang 2>/dev/null)
DAE_STRIP:=$(shell command -v llvm-strip 2>/dev/null)

define Package/dae
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=eBPF-based transparent proxy (CO-RE)
  URL:=https://github.com/daeuniverse/dae
  LICENSE:=AGPL-3.0-only
  # dae is a static Go binary, so it needs no libraries at runtime. Its eBPF
  # datapath attaches TC programs to the LAN/WAN interfaces and creates a veth
  # pair plus the daens namespace, hence the kernel modules below; its CO-RE
  # programs need the kernel's BTF, which vmlinux-btf installs on official
  # OpenWrt and vmlinux-btf-builtin stands in for where the kernel has its own.
  # The geo packages ship the dat files dae looks up as geoip:/geosite:; this
  # package only links them into /usr/share/dae.
  DEPENDS:=+ca-bundle +kmod-sched-core +kmod-sched-bpf +kmod-veth \
           +vmlinux-btf +v2ray-geoip +v2ray-geosite
endef

define Package/dae/description
 dae is an eBPF-based transparent proxy for Linux. Its datapath uses CO-RE
 eBPF programs, so the running kernel needs BTF, which vmlinux-btf provides.
endef

define Build/Prepare
	@if [ ! -d "$(DAE_SRC)" ]; then \
		echo "dae: the source tree is missing at $(DAE_SRC)"; \
		echo "dae: run 'git clone --recurse-submodules https://github.com/daeuniverse/dae src' in $(PKG_DIR)"; \
		exit 1; \
	fi
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) $(DAE_SRC)/. $(PKG_BUILD_DIR)/
endef

define Build/Compile
	DAE_SRC="$(PKG_BUILD_DIR)" \
	DAE_VERSION="$(PKG_VERSION)" \
	DAE_ARCH_PACKAGES="$(ARCH_PACKAGES)" \
	DAE_CLANG="$(DAE_CLANG)" \
	DAE_STRIP="$(DAE_STRIP)" \
	sh "$(PKG_DIR)/build.sh"
endef

define Package/dae/conffiles
/etc/config/dae
/etc/dae/config.dae
endef

# apk replaces a conffile the user never edited with the packaged one, which
# has no option enabled, so the boot setting of earlier versions is saved here
# for files/dae.uci-defaults. The apk pre-install and pre-upgrade scripts are
# made from this (pre-upgrade without the shebang line, after PKG_UPGRADE=1).
define Package/dae/preinst
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
enabled="$$(uci -q get dae.config.enabled)"
[ -z "$$enabled" ] || echo "$$enabled" > /tmp/dae-autostart
exit 0
endef

# With apk this runs after default_postinst, in post-install and, sourced, in
# post-upgrade. The restart picks up a new binary of an enabled service; the
# init script's package guard keeps it from starting a disabled one.
define Package/dae/postinst
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
/etc/init.d/dae enabled && /etc/init.d/dae restart
exit 0
endef

define Package/dae/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/dae $(1)/usr/bin/dae
	$(INSTALL_DIR) $(1)/usr/share/licenses/dae
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/LICENSE $(1)/usr/share/licenses/dae/LICENSE
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_DIR)/files/dae.init $(1)/etc/init.d/dae
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(PKG_DIR)/files/dae.config $(1)/etc/config/dae
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) $(PKG_DIR)/files/dae.uci-defaults $(1)/etc/uci-defaults/90-dae-autostart
	$(INSTALL_DIR) $(1)/etc/dae
	$(INSTALL_CONF) $(PKG_BUILD_DIR)/example.dae $(1)/etc/dae/config.dae
	# v2ray-geoip/geosite install the files under /usr/share/v2ray. dae searches
	# /usr/share/dae (common/assets, folder "dae"), so point it there.
	$(INSTALL_DIR) $(1)/usr/share/dae
	$(LN) ../v2ray/geoip.dat $(1)/usr/share/dae/geoip.dat
	$(LN) ../v2ray/geosite.dat $(1)/usr/share/dae/geosite.dat
endef

$(eval $(call BuildPackage,dae))
