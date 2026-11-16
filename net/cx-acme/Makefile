#
# Copyright (C) 2026 CX
#
# This is free software, licensed under the GNU General Public License v3.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=cx-acme
PKG_VERSION:=3.1.4
PKG_RELEASE:=1

PKG_SOURCE:=acme.sh-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/acmesh-official/acme.sh/tar.gz/$(PKG_VERSION)?
PKG_HASH:=e5f8e187bbf5251e0cd8891f2622daab9850366bd17bea9f92c2fe2ee091fd32
PKG_BUILD_DIR:=$(BUILD_DIR)/acme.sh-$(PKG_VERSION)

PKG_MAINTAINER:=CX <cx@imcaoxuan.cn>
PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE.md

include $(INCLUDE_DIR)/package.mk

define Package/cx-acme
  SECTION:=net
  CATEGORY:=Network
  DEPENDS:=+wget-ssl +ca-bundle +openssl-util +socat
  TITLE:=ACME client acme.sh wrapper (cx-acme)
  URL:=https://acme.sh
  PKGARCH:=all
  CONFLICTS:=acme-common acme-acmesh acme-acmesh-dnsapi uacme
endef

define Package/cx-acme/description
  Automatic ACME (e.g. Let's Encrypt) certificate issuance and renewal,
  wrapping acme.sh with procd integration. Standalone replacement for
  acme-common/acme-acmesh with its own config (/etc/config/cx-acme) and
  certificate directory (/etc/ssl/cx-acme).
endef

define Package/cx-acme/conffiles
/etc/config/cx-acme
/etc/cx-acme
/etc/ssl/cx-acme
endef

define Package/cx-acme/install
	$(INSTALL_DIR) $(1)/usr/lib/cx-acme/client
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/acme.sh $(1)/usr/lib/cx-acme/client
	$(INSTALL_BIN) ./files/hook.sh $(1)/usr/lib/cx-acme/hook
	$(INSTALL_DATA) ./files/functions.sh $(1)/usr/lib/cx-acme
	$(INSTALL_BIN) ./files/cx-acme-notify.sh $(1)/usr/lib/cx-acme/notify
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/cx-acme.init $(1)/etc/init.d/cx-acme
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/cx-acme.config $(1)/etc/config/cx-acme
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/cx-acme.uci-defaults $(1)/etc/uci-defaults/cx-acme
	$(INSTALL_DIR) $(1)/etc/cx-acme
	$(INSTALL_DIR) $(1)/etc/ssl/cx-acme
	$(INSTALL_DIR) $(1)/etc/hotplug.d/cx-acme
endef

define Package/cx-acme/prerm
#!/bin/sh
[ -f /etc/crontabs/root ] && sed -i '\|/etc/init.d/cx-acme|d' /etc/crontabs/root
exit 0
endef

define Package/cx-acme-dnsapi
  SECTION:=net
  CATEGORY:=Network
  DEPENDS:=+cx-acme
  TITLE:=DNS API integration for cx-acme
  PKGARCH:=all
  CONFLICTS:=acme-acmesh-dnsapi
endef

define Package/cx-acme-dnsapi/description
  This package provides DNS API integration for the cx-acme ACME client,
  enabling DNS-01 challenge validation (including wildcard certificates).
endef

define Package/cx-acme-dnsapi/install
	$(INSTALL_DIR) $(1)/usr/lib/cx-acme/client/dnsapi
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/dnsapi/*.sh $(1)/usr/lib/cx-acme/client/dnsapi
endef

define Build/Configure
endef

define Build/Compile
endef

$(eval $(call BuildPackage,cx-acme))
$(eval $(call BuildPackage,cx-acme-dnsapi))