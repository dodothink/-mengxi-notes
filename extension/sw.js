importScripts('state.js', 'background.js', 'poster.js', 'challenge.js', 'control.js', 'alerts.js', 'api.js');
// 扩展模块（最终产品打包时替换 addons/addons.js）；出错不影响插件本身
try { importScripts('addons/addons.js'); } catch (e) { console.warn('扩展模块加载失败', e); }
