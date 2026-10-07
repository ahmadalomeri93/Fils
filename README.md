# فلس

تطبيق مصاريف شخصي بالعربي (PWA). كل البيانات تبقى في جهاز المستخدم (localStorage)، وما في أي خادم.

- ملفات الموقع في `dist/`.
- `wrangler.jsonc` ينشر `dist/` على Cloudflare Workers (ملفات ثابتة) مع ترويسات الأمان في `dist/_headers`.
- أي تعديل يندمج في `main` ينشره Cloudflare تلقائياً.
- النشر التلقائي مربوط بمشروع Cloudflare `broken-queen-f0ed` (فرع main).
