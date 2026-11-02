# @tripquest/auth

使用 Better Auth 实现用户名/密码、数据库会话、HttpOnly Cookie、Bearer 会话与登录限流；应用补充邀请码注册、账号删除和本机管理命令。

- `src/auth.ts`：Better Auth 与 Drizzle 适配，关闭不使用的公开注册、邮件及管理接口。
- `src/invites.ts`、`register.ts`：一次性邀请码，数据库只存哈希，注册时原子领取。
- `src/account.ts`：验证密码后删除账号相关业务数据与图检查点；管理账号禁止自行删除。
- `src/cli.ts`：本地账号管理；Web 会话读取见 `apps/web/src/app/auth/session.ts`。

根 `.env` 配置 `BETTER_AUTH_SECRET`（至少 32 字符）和 `BETTER_AUTH_URL`。迁移创建无密码的 `owner` 管理账号，首次启动前设置密码：

```bash
pnpm users set-password owner
pnpm users invite
pnpm users list
pnpm users limit <username> <category> <count>
pnpm users disable <username>
```

密码交互输入，不写入命令行。仓库按当前用户过滤业务数据，其他用户的 ID 按不存在处理。`pnpm test:auth` 需要 `_test` 数据库的 `TEST_DATABASE_URL`。
