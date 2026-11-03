#
# OpenWrt package: luci-app-honk
#
# LuCI page for honk, built on luci-lib-daeuniverse: the Start at boot switch, an
# editor with syntax highlighting for /etc/honk/config.dae and every file it
# includes, and the service log. Needs the luci feed in the SDK, as luci.mk
# comes from there.
#
# This file is free software, licensed under the GNU General Public License v3
# or later.

include $(TOPDIR)/rules.mk

PKG_LICENSE:=GPL-3.0-or-later

LUCI_TITLE:=LuCI support for honk
LUCI_DEPENDS:=+luci-lib-daeuniverse +honk
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
