# syntax=docker/dockerfile:1
# ---- 折页阅读顺序校样 Web 应用镜像 ----
FROM node:20-alpine

WORKDIR /app

# 仅先拷贝依赖清单，利用层缓存安装依赖
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 拷贝应用代码
COPY server.js ./
COPY public ./public
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh \
  && mkdir -p /app/data

# 标签 / 备注 / 校样批注 / 列表筛选 / 版本差异：
#  - 方案与标签/备注/批注持久化在命名卷 DATA_DIR（/app/data），容器重建不丢失；
#  - 写入走临时文件 + rename 原子替换，非法请求（含坏批注）整请求拒绝，不会留下半截存档；
#  - 每次成功保存在 <id>.versions/ 追加只写一次的不可变版本快照，供两版本差异审阅与恢复；
#  - 批注绑定原始面片身份（cell+face），切换回放步或重排折叠后由引擎重新定位；
#  - 存档列表筛选（标签交集 / 名称关键词 / since）均为只读查询，不产生额外文件。
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

EXPOSE 3000

# 依赖准备与初始化（数据目录、自检）在容器启动时执行
ENTRYPOINT ["./entrypoint.sh"]
