#
# OpenWrt package: luci-lib-daeuniverse
#
# The LuCI page luci-app-dae and luci-app-honk share: service status with the
# UCI switch, an editor with syntax highlighting for the configuration file and
# every file it includes (one tab per file, each saved to its own path), and the
# service log. The apps only describe their service. Needs the luci feed in the
# SDK, as luci.mk comes from there.
#
# This file is free software, licensed under the GNU General Public License v3
# or later.

include $(TOPDIR)/rules.mk

PKG_LICENSE:=GPL-3.0-or-later

LUCI_TITLE:=Shared LuCI page for dae and honk
LUCI_DEPENDS:=+luci-base +jshn +flock +coreutils-timeout
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
