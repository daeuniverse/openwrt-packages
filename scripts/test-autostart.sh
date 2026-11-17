#!/bin/sh
# Runs the boot setting logic of the dae and honk packages against a temporary
# root: the uci-defaults script, the preinst and postinst scripts of the
# Makefile and the boot and start of the init script. uci, the init script's
# enable/enabled/restart, rc.common and the procd helpers are stubs; absolute
# paths in the scripts are moved below the temporary root.
#
#   sh scripts/test-autostart.sh [source tree]
#
# The source tree defaults to the checkout this script is in.

SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fails=0

# Moves the absolute paths of a script below $T
relocate() {
	set --
	for dir in etc tmp sys proc usr; do
		set -- "$@" -e "s#^/$dir/#@ROOT@/$dir/#" \
			-e "s#\\([[:space:](\"'=]\\)/$dir/#\\1@ROOT@/$dir/#g"
	done
	# $T may itself start with one of them
	sed "$@" -e "s#@ROOT@#$T#g"
}

# A fresh temporary root for package $1, with its configuration file
setup() {
	pkg="$1"
	T="$(mktemp -d)"
	mkdir -p "$T/bin" "$T/uci" "$T/tmp" "$T/etc/init.d" "$T/etc/rc.d" \
		"$T/etc/$pkg" "$T/usr/bin" "$T/sys/kernel/btf" "$T/proc"
	: > "$T/log"
	: > "$T/proc/mounts"
	: > "$T/sys/kernel/btf/vmlinux"
	: > "$T/etc/$pkg/config.dae"
	echo "$T/etc/$pkg/config.dae" > "$T/uci/$pkg.config.config_file"

	# uci: one file per option
	cat > "$T/bin/uci" <<EOF
#!/bin/sh
[ "\$1" = -q ] && shift
case "\$1" in
get) cat "$T/uci/\$2" 2>/dev/null ;;
set) printf '%s\n' "\${2#*=}" > "$T/uci/\${2%%=*}" ;;
delete) rm -f "$T/uci/\$2" ;;
commit) echo "uci commit \$2" >> "$T/log" ;;
esac
EOF
	# The init script as the package scripts and uci-defaults call it
	cat > "$T/etc/init.d/$pkg" <<EOF
#!/bin/sh
case "\$1" in
enable) : > "$T/etc/rc.d/S99$pkg" ;;
disable) rm -f "$T/etc/rc.d/S99$pkg" ;;
enabled) [ -e "$T/etc/rc.d/S99$pkg" ] ;;
*) echo "init \$1" >> "$T/log" ;;
esac
EOF
	printf '#!/bin/sh\nexit 0\n' > "$T/usr/bin/dae"
	printf '#!/bin/sh\nexit 0\n' > "$T/usr/bin/honk-core"
	chmod +x "$T/bin/uci" "$T/etc/init.d/$pkg" "$T/usr/bin/dae" "$T/usr/bin/honk-core"

	relocate < "$SRC/$pkg/files/$pkg.uci-defaults" > "$T/uci-defaults"
	relocate < "$SRC/$pkg/files/$pkg.init" > "$T/init"
	for script in preinst postinst; do
		sed -n "/^define Package\/$pkg\/$script\$/,/^endef\$/p" "$SRC/$pkg/Makefile" |
			sed -e '1d;$d' -e 's/\$\$/$/g' | relocate > "$T/$script"
	done
}

option() { cat "$T/uci/$pkg.config.enabled" 2>/dev/null; }
set_option() { echo "$1" > "$T/uci/$pkg.config.enabled"; }
link() { [ -e "$T/etc/rc.d/S99$pkg" ]; }

# Runs action $1 of the init script the way rc.common does: its default boot
# calls start, the script may override it, and procd's start runs
# start_service. procd_open_instance logs that the service started.
init() {
	(
		PATH="$T/bin:$PATH"
		config_load() { :; }
		config_get() {
			eval "$1=\"\$(uci -q get \$CONF.\$2.\$3)\""
			eval "[ -n \"\$$1\" ]" || eval "$1=\"\$4\""
		}
		procd_open_instance() { echo "started" >> "$T/log"; }
		procd_set_param() { :; }
		procd_append_param() { :; }
		procd_close_instance() { :; }
		procd_add_reload_trigger() { :; }
		procd_running() { return 1; }
		ubus() { return 1; }
		jsonfilter() { :; }
		logger() { shift 2; echo "logger: $*" >> "$T/log"; }
		mount() { :; }
		boot() { start "$@"; }
		. "$T/init"
		start() { start_service "$@"; }
		"$@"
	)
}

# A boot runs the init script's boot only through its rc.d link
boot() { link && init boot; }
started() { grep -qx started "$T/log"; }

# uci-defaults on the first boot of a firmware image: the image build enabled
# every init script, and pkgname is not set
first_boot() {
	: > "$T/etc/rc.d/S99$pkg"
	(PATH="$T/bin:$PATH"; unset pkgname; cd "$T" && . "$T/uci-defaults")
}

# sysupgrade keeps /etc/config but not /etc/rc.d
sysupgrade() {
	rm -f "$T/etc/rc.d/S99$pkg"
	: > "$T/log"
	first_boot
	boot
}

# apk add or upgrade: preinst, the new files (a conffile without the option
# when $1 is replace), then default_postinst (uci-defaults, enable on an
# install, start) and postinst
apk() {
	mode="$1" conffile="$2"
	(PATH="$T/bin:$PATH"; pkgname="$pkg"; . "$T/preinst")
	[ "$conffile" = replace ] && rm -f "$T/uci/$pkg.config.enabled"
	: > "$T/log"
	(
		PATH="$T/bin:$PATH"
		export pkgname="$pkg"
		[ "$mode" = upgrade ] && export PKG_UPGRADE=1
		(cd "$T" && . "$T/uci-defaults")
		[ "$mode" = upgrade ] || "$T/etc/init.d/$pkg" enable
		init start
		. "$T/postinst"
	)
}

check() {
	if eval "$2"; then
		echo "ok   $pkg: $1"
	else
		echo "FAIL $pkg: $1"
		fails=$((fails + 1))
	fi
}

for pkg in dae honk; do
	setup "$pkg"
	first_boot
	: > "$T/log"
	boot
	check "(a) fresh image: enabled 0, link enabled" '[ "$(option)" = 0 ] && link'
	check "(a) fresh image: not started at boot" '! started'
	rm -rf "$T"

	setup "$pkg"
	set_option 1
	sysupgrade
	check "(b) sysupgrade keeping enabled 1: still 1" '[ "$(option)" = 1 ]'
	check "(b) sysupgrade keeping enabled 1: started at boot" 'started'
	sysupgrade
	check "(b) second sysupgrade: still 1" '[ "$(option)" = 1 ]'
	check "(b) second sysupgrade: started at boot" 'started'
	rm -rf "$T"

	setup "$pkg"
	set_option 0
	sysupgrade
	check "(c) sysupgrade keeping enabled 0: still 0" '[ "$(option)" = 0 ]'
	check "(c) sysupgrade keeping enabled 0: not started at boot" '! started'
	rm -rf "$T"

	setup "$pkg"
	: > "$T/etc/rc.d/S99$pkg"
	apk upgrade replace
	check "(d) upgrade from the rc.d link design, link on: enabled 1" '[ "$(option)" = 1 ]'
	check "(d) upgrade, link on: restarted" 'started && grep -qx "init restart" "$T/log"'
	: > "$T/log"
	boot
	check "(d) upgrade, link on: started at boot" 'started'
	rm -rf "$T"

	setup "$pkg"
	apk upgrade replace
	check "(d) upgrade from the rc.d link design, link off: enabled 0" '[ "$(option)" = 0 ]'
	check "(d) upgrade, link off: not started, not restarted" '! started && ! grep -q "init restart" "$T/log"'
	: > "$T/log"
	boot
	check "(d) upgrade, link off: not started at boot" '! started'
	rm -rf "$T"

	setup "$pkg"
	set_option 1
	apk upgrade replace
	check "(e) upgrade from the option design, unedited conffile: enabled 1" '[ "$(option)" = 1 ]'
	check "(e) upgrade from the option design: saved value removed" '[ ! -e "$T/tmp/$pkg-autostart" ]'
	: > "$T/log"
	boot
	check "(e) upgrade from the option design: started at boot" 'started'
	rm -rf "$T"

	setup "$pkg"
	apk install
	check "(g) apk add: enabled 0, link enabled" '[ "$(option)" = 0 ] && link'
	check "(g) apk add: not started" '! started'
	rm -rf "$T"

	setup "$pkg"
	set_option 0
	: > "$T/etc/rc.d/S99$pkg"
	init start
	check "(f) start by hand with enabled 0: started" 'started'
	rm -rf "$T"
done

[ "$fails" -eq 0 ] && echo "all passed" || echo "$fails failed"
[ "$fails" -eq 0 ]
