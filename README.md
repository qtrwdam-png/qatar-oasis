# 💧 مياه واحة قطر - Water Oman

منصة تجارة إلكترونية متكاملة لبيع مياه الشرب مع لوحة تحكم إدارية، وتتبع زوار، وإشعارات فورية.

## 🚀 المميزات

- واجهة عميل تعرض المنتجات وتدعم الصفحات: الرئيسية، التوصيل، الدفع، التحقق
- لوحة تحكم إدارية للتتبع والإحصائيات وإدارة المنتجات والمحظورين
- اتصال مباشر عبر Socket.IO للتحديثات اللحظية
- إشعارات push وإشعارات صوتية للمدير
- دعم قاعدة بيانات PostgreSQL (Neon)

## 🛠️ التقنيات المستخدمة

- Node.js + Express
- Socket.IO
- PostgreSQL / Neon
- Firebase Admin SDK (لـ FCM)
- HTML / CSS / JavaScript

## 📦 هيكل المشروع

```text
wateroman/
├── backend/
│   ├── config/
│   ├── models/
│   ├── routes/
│   ├── server.js
│   ├── package.json
│   └── .env
├── frontend/
│   ├── admin/
│   ├── pages/
│   ├── css/
│   └── js/
├── package.json
├── railway.json
├── backend/Procfile
└── README.md
```

## ⚙️ التشغيل على Railway

هذا المشروع جاهز للنشر على Railway كخدمة واحدة، حيث سيكتشف Railway تلقائيًا:

- استخدام Node.js
- تشغيل Backend من [backend/server.js](backend/server.js)
- استخدام ملف [package.json](package.json) في الجذر
- استخدام [railway.json](railway.json) للتهيئة

### ما الذي تحتاجه في Railway

أضف المتغيرات البيئية التالية يدويًا في قسم Variables داخل Railway (بدلًا من الاعتماد على ملف .env المحلي):

```env
ADMIN_DEFAULT_PASSWORD=admin123
DATABASE_URL=postgresql://... 
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@adminqatar-d4192.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
FIREBASE_PROJECT_ID=adminqatar-d4192
NODE_ENV=production
VAPID_PRIVATE_KEY=...
VAPID_PUBLIC_KEY=...
PORT=3000
```

### ملاحظات مهمة

- يجب أن يكون المشروع مرتبطًا بـ GitHub ثم ربط المستودع مع Railway.
- Railway سيستخدم [railway.json](railway.json) تلقائيًا ويشغل المشروع عبر [package.json](package.json).
- تطبيق الواجهة والـ API يعملان من نفس الخادم الخلفي، لذلك لا حاجة لخدمة منفصلة للـ frontend.
- لا تعتمد على ملف [.env](backend/.env) أثناء النشر على Railway؛ أدخل القيم يدويًا في Variables داخل Railway.
- إذا كانت القيمة تحتوي على أسطر متعددة مثل `FIREBASE_PRIVATE_KEY`، احتفظ بها بصيغة سلسلة نصية كاملة داخل Railway Variables.

## ▶️ التشغيل محليًا

```bash
cd backend
npm install
npm start
```

ثم افتح:
- http://localhost:3000
- http://localhost:3000/admin

## 🔐 بيانات الدخول الافتراضية

- اسم المستخدم: admin
- كلمة المرور: admin123

## 📝 الرخصة

MIT License
