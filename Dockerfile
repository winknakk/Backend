# ==========================================
# สเตจที่ 1: Compile TypeScript (Builder Stage)
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

# คัดลอกเฉพาะไฟล์สัญญาโครงสร้างแพ็กเกจ
COPY package*.json tsconfig.json ./

# ติดตั้ง Dependencies ทั้งหมด (รวม devDependencies เช่น typescript)
RUN npm ci

# คัดลอกซอร์สโค้ดทั้งหมดเข้ามาในตู้คอนเทนเนอร์
COPY . .

# สั่งคอมไพล์รหัสจาก TypeScript แปลงเป็น JavaScript ลงโฟลเดอร์ dist
RUN npm run build

# สั่งล้างแพ็กเกจ devDependencies ออกจากโฟลเดอร์ node_modules เพื่อให้เหลือเฉพาะของใช้จริงบน Production
RUN npm prune --production


# ==========================================
# สเตจที่ 2: รันระบบจริงบนสภาพแวดล้อมจำกัด (Production Stage)
# ==========================================
FROM node:20-alpine
WORKDIR /app

# คัดลอกเฉพาะไฟล์ที่คอมไพล์ผ่านสมบูรณ์แบบแล้วเข้ามา
COPY --from=builder /app/dist ./dist

# คัดลอกโฟลเดอร์ node_modules ที่ถูกล้างเอาเฉพาะ Production ไลบรารีมาเรียบร้อยแล้ว
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# คัดลอกคลังโฟลเดอร์คู่มือและฐานข้อมูลสำหรับการรันระบบ V3
COPY --from=builder /app/database ./database
COPY --from=builder /app/prompts ./prompts


# ตั้งค่าสภาพแวดล้อมเป็นโหมดปลอดภัยความเร็วสูง
ENV NODE_ENV=production

# เปิดพอร์ตต้อนรับทราฟฟิกหลังบ้าน
EXPOSE 3000

# ด่านตรวจเช็คสุขภาพระบบ (Healthcheck Gate)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

# คำสั่งสตาร์ทตัวประมวลผล Fastify Core API Server
CMD ["node", "dist/api/server.js"]