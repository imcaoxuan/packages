# cx-acme 使用文档

cx-acme 是 OpenWrt 上的 ACME 自动证书管理方案，包装 [acme.sh](https://acme.sh) 3.1.4，
提供 procd 集成、LuCI 界面（`luci-app-cx-acme`）和 nightly 自动续期。
它是官方 `acme-common`/`acme-acmesh`/`luci-app-acme` 的独立重写版，修复了凭据损坏、
证书链接不更新、UI 日期错误等一系列问题，**与官方 acme 包互斥（CONFLICTS），不能共存**。

## 目录与路径

| 用途 | 路径 |
|---|---|
| UCI 配置 | `/etc/config/cx-acme` |
| ACME 账户/域名状态 | `/etc/cx-acme` |
| 证书输出（符号链接） | `/etc/ssl/cx-acme` |
| HTTP-01 challenge 目录 | `/var/run/cx-acme/challenge` |
| 包装脚本 | `/usr/lib/cx-acme/` |
| hotplug 事件脚本 | `/etc/hotplug.d/cx-acme/` |
| 日志 tag | `cx-acme`（`logread -e cx-acme`） |

每个域名输出 5 个链接（`<domain>` 为主域名，即 domains 列表第一项）：

```
/etc/ssl/cx-acme/<domain>.crt            # 域名证书
/etc/ssl/cx-acme/<domain>.key            # 私钥
/etc/ssl/cx-acme/<domain>.fullchain.crt  # 证书 + 中间链（web 服务器常用）
/etc/ssl/cx-acme/<domain>.chain.crt      # 中间链
/etc/ssl/cx-acme/<domain>.combined.crt   # fullchain + 私钥（haproxy 等常用）
```

链接在每次签发/续期成功后无条件刷新，切换 key_type（EC↔RSA）后也会正确指向新证书。

## 安装

### 获取 ipk

- GitHub Actions：推送 `cx-acme-v*` tag 自动发布 Release；手动运行 "Build cx-acme"
  工作流可在 Artifacts 下载（默认目标 OpenWrt 23.05.2 x86_64，可改版本/目标）。
- 产物：`cx-acme_*.ipk`、`cx-acme-dnsapi_*.ipk`（DNS API 集合）、`luci-app-cx-acme_*.ipk`。

### 安装步骤

依赖 `wget-ssl`、`socat`（standalone 模式的监听器）、`ca-bundle`、`openssl-util`，
opkg 会从软件源解析；若报找不到依赖，先 `opkg update`，并确认
`/etc/opkg/distfeeds.conf` 未被注释。

**从官方 acme 迁移时务必先备份**——opkg remove 会删除旧包的 conffiles
（`/etc/config/acme` 和 `/etc/acme` 账户状态），而迁移需要它们：

```sh
# 1. 备份
cp /etc/config/acme /tmp/acme.config.bak
cp -a /etc/acme /tmp/acme-state.bak

# 2. 卸载旧包（按实际安装情况增减）
opkg remove luci-app-acme acme-acmesh-dnsapi acme-acmesh acme-common

# 3. 若被删除则恢复
[ -f /etc/config/acme ] || cp /tmp/acme.config.bak /etc/config/acme
[ -d /etc/acme ] || cp -a /tmp/acme-state.bak /etc/acme

# 4. 安装
opkg install ./cx-acme_*.ipk ./cx-acme-dnsapi_*.ipk ./luci-app-cx-acme_*.ipk

# 5. 启用
/etc/init.d/cx-acme enable
/etc/init.d/cx-acme start
```

### 自动迁移

首次开机（或安装后手动执行 `sh /etc/uci-defaults/cx-acme`）会一次性迁移：

- 旧选项换算：`keylength`→`key_type`、`use_staging`→`staging`、
  `standalone`/`tls`→`validation_method`、`acme_uri`→`acme_server`
- 凭据剥去成对引号，统一为裸 `KEY=VAL`；含单引号的值会被丢弃并告警（见下文限制）
- `webroot`、`state_dir` 选项丢弃并告警（新设计使用固定路径）
- `/etc/acme` 状态整体复制到 `/etc/cx-acme`（保留账户密钥与续期时间戳，
  避免重复注册账户触发速率限制），并重写其中保存的旧 hook/webroot 路径
- 从迁移状态重建 `/etc/ssl/cx-acme` 证书链接
- 创建 `/www/.well-known/acme-challenge` 符号链接（已存在真实目录时不覆盖）

旧配置 `/etc/config/acme` 不会被修改，可随时回滚。迁移成功后脚本自动删除；
已有 cert section 时重复执行会跳过。

## 快速开始（LuCI）

菜单 **Services → cx-acme**：

1. 全局配置填 `Account email`（必填，证书过期提醒用）。
2. Certificate config 点 Add：填域名（第一项为主域名）、选验证方式。
3. DNS 方式需安装 `cx-acme-dnsapi`，选择 DNS API 后按字段填凭据。
4. Save & Apply 后立即触发签发，进度看 **Log View** 页或 `logread -e cx-acme`。

若检测到 ddns 配置（duckdns/dynv6/freedns/cloudflare），全局区会出现
"Found DDNS domains" 导入按钮，一键生成对应 DNS 证书配置并触发签发。

## 验证方式

| 方式 | 端口 | 说明 |
|---|---|---|
| `standalone` | 80（可改 `listen_port`） | acme.sh 自带临时监听器（依赖 socat），签发期间自动在防火墙放行端口，结束后删除规则。需公网可达该端口 |
| `webroot` | 80 | 复用现有 web 服务器。challenge 固定写入 `/var/run/cx-acme/challenge`，web 服务器须能服务该目录（uhttpd 通过 `/www/.well-known/acme-challenge` 符号链接自动满足）。`listen_port` 仅用于临时放行防火墙 |
| `alpn` | 443（可改） | TLS-ALPN-01，需 443 公网可达且无其他服务占用（acme.sh 临时接管） |
| `dns` | 无需开端口 | DNS-01，通过 DNS API 写 TXT 记录；**唯一支持通配符**的方式；域名无需解析到路由器 |

webroot 自检：

```sh
ls -l /www/.well-known/acme-challenge   # 应为指向 /var/run/cx-acme/challenge/... 的符号链接
echo test > /var/run/cx-acme/challenge/.well-known/acme-challenge/test
curl http://127.0.0.1/.well-known/acme-challenge/test   # 应输出 test
```

注意：HTTP-01 协议固定走 80 端口，`listen_port` 改不了 CA 的访问端口，
只影响防火墙放行；uhttpd 必须监听 80。

## 配置参考

全局 section（`config acme`，只读第一个）：

| 选项 | 说明 |
|---|---|
| `account_email` | 必填，ACME 账户邮箱 |
| `debug` | 0/1，调试日志 |

证书 section（`config cert <name>`，可多个）：

| 选项 | 说明 |
|---|---|
| `enabled` | 0/1，默认 1 |
| `domains` | 列表，第一项为主域名；通配符 `*.example.com` 仅限 dns 方式 |
| `validation_method` | `standalone`/`webroot`/`alpn`/`dns`，必填 |
| `listen_port` | 临时放行的端口；standalone 默认 80，alpn 默认 443 |
| `dns` | dns 方式的 API 名（如 `dns_cf`），须与已安装 dnsapi 脚本对应 |
| `credentials` | 列表，裸 `KEY=VAL` 格式，**不要加引号**，值可含 `$`、`"`、反引号、空格 |
| `calias` / `dalias` | DNS challenge/domain alias（二者同时设置时 calias 被忽略） |
| `dns_wait` | DNS 记录传播等待秒数 |
| `key_type` | `ec256`（默认）/`ec384`/`rsa2048`/`rsa3072`/`rsa4096` |
| `acme_server` | 自定义 CA directory URL；设置后 staging 失效 |
| `staging` | 0/1，Let's Encrypt 测试环境（证书不受信任，仅调试用） |
| `days` | 续期阈值天数，**建议留空**（acme.sh 默认 60） |
| `cert_profile` | ACME profiles 扩展；LE 可选 `tlsserver`（默认）/`shortlived`（约 6 天、支持 IP 证书，需配合更短 days）；多数 CA 不支持，留空即可 |

凭据限制：值**不能含单引号**——acme.sh 上游用未转义单引号落盘凭据，
含单引号会损坏其 account.conf，UI 与后端都会明确拒绝。

示例（DNS + Cloudflare）：

```
config cert 'wildcard'
    option enabled '1'
    list domains 'example.com'
    list domains '*.example.com'
    option validation_method 'dns'
    option dns 'dns_cf'
    list credentials 'CF_Token=你的token'
    option key_type 'ec256'
```

## 命令行

```sh
service cx-acme start     # 启用 nightly 续期（cron 0 0 * * *）
service cx-acme stop      # 停用 nightly 续期，并中止进行中的签发
service cx-acme renew     # 立即后台签发/续期
service cx-acme abort     # 中止全部进行中的签发/续期
service cx-acme abort <section>   # 中止指定证书
logread -e cx-acme        # 查看日志
uci show cx-acme          # 查看配置
```

配置变更（uci apply）会自动触发 renew。续期使用签发时保存的参数；
**修改验证方式/DNS API 后若续期不生效**，删除对应状态目录强制重签：

```sh
rm -rf /etc/cx-acme/<domain> /etc/cx-acme/<domain>_ecc
service cx-acme renew
```

## 事件集成

签发/续期事件通过 hotplug 与 ubus 发出，可用于自动重启服务：

- hotplug：`/etc/hotplug.d/cx-acme/` 下脚本收到 `ACTION` =
  `prepare` / `issued` / `renewed` / `issue-failed` / `renew-failed`
- ubus service event：`cx-acme.issue`、`cx-acme.renew`

例：证书更新后重启 uhttpd（`/etc/hotplug.d/cx-acme/50-reload`）：

```sh
#!/bin/sh
[ "$ACTION" = issued ] || [ "$ACTION" = renewed ] || exit 0
service uhttpd restart
```

uhttpd 使用证书：

```sh
uci set uhttpd.main.cert='/etc/ssl/cx-acme/example.com.fullchain.crt'
uci set uhttpd.main.key='/etc/ssl/cx-acme/example.com.key'
uci commit uhttpd
service uhttpd restart
```

## 私有 CA

`acme_server` 填 directory URL 即可，如 step-ca：
`https://ca.home.arpa:9000/acme/acme/directory`。
私有 CA 可签发 `home.arpa` 等内部域名；但 **Let's Encrypt 等公共 CA 不能**
（`home.arpa`、`.local`、`.test` 等为保留特殊用途域名，UI 会拒绝并提示）。
私有 CA 的根证书需自行加入系统信任 store（`/etc/ssl/certs/`）。

## FAQ / 故障排查

**安装报 conflicts（acme-common/acme-acmesh/...）**
预期行为，先卸载旧包（见安装步骤，记得备份）。

**找不到 wget-ssl/socat 依赖**
`opkg update`；仍失败检查 distfeeds.conf 是否被注释。

**日志报 `/usr/lib/acme/notify: not found`**
迁移状态里保存的旧 hook 路径。新版已在续期前自动重写；旧版手动修：
```sh
sed -i -e 's|/usr/lib/acme/|/usr/lib/cx-acme/|g' \
       -e 's|/var/run/acme/|/var/run/cx-acme/|g' /etc/cx-acme/*/*.conf
```

**LuCI 证书表 "No data"**
`/etc/ssl/cx-acme` 还没有链接。新版在迁移和续期跳过时都会建链接；
旧版可手动从状态目录重建（对每个含 `fullchain.cer` 的域名目录执行
`ln -sf` 五个链接），或强制重签。若状态目录里根本没有域名目录，
说明从未签发成功，看日志里的签发错误。

**webroot 验证超时失败**
按顺序查：`/www/.well-known/acme-challenge` 是否为符号链接（旧包用过
`webroot '/www'` 的机器上可能是真实目录，需移开后重建链接）→ uhttpd 是否
监听 80 → 本机 curl 自检 → CA 侧能否解析并访问该域名（看 CA 日志的验证错误）。
`webroot`、`use_acme_server` 是旧选项，cx-acme 中无效，可删除。

**LE 签发 home.arpa 被拒**
特殊用途域名公共 CA 不签，改用公网域名或私有 CA。

**凭据里有特殊字符**
`$`、`"`、反引号、`=`、空格都安全（后端无 eval，procd 原样传环境变量）；
单引号不允许（acme.sh 上游限制）。

**days 设 0**
不建议，留空用默认 60 天阈值。

## 构建

GitHub Actions 工作流 `.github/workflows/cx-acme.yml` 基于官方 SDK 构建
（ubuntu-22.04 runner——新版 ubuntu 镜像的 uutils coreutils 会导致 SDK
prereq 误报）。本地构建等价流程：下载对应版本 SDK → 拷贝
`net/cx-acme` 与 `applications/luci-app-cx-acme` 到 `package/` →
feeds update/install → 选包为 m → `make package/cx-acme/compile
package/luci-app-cx-acme/compile`。

## 设计要点

- 凭据链路无 eval：UCI 裸值 → `procd_append_param env`（纯字符串切分）→
  execve 环境变量 → acme.sh dnsapi 读取，杜绝 shell 注入
- 证书链接无条件 `ln -sf` 刷新；combined 文件 umask 077
- nft 临时规则严格校验端口（1–65535），开端口失败立即中止签发
- 信号处理 busybox ash 安全（cgroup → 进程组 → 递归子进程三级降级）
- 迁移幂等、不修改旧配置，保留回滚能力