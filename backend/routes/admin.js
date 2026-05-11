const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { makeLicenseKey, productIdFromName, invoiceNumber } = require('../utils');
const router = express.Router();
router.use(authRequired, adminRequired);
async function log(req, action, type, id, metadata={}){ try{ await pool.query('INSERT INTO admin_logs (admin_id,action,target_type,target_id,metadata) VALUES ($1,$2,$3,$4,$5)', [req.user.id,action,type,id,metadata]); }catch(e){ console.error(e); } }
router.get('/summary', async (req,res)=>{
  const keys=['users','products','licenses','license_activations','downloads','invoices','support_tickets'];
  const out={}; for(const k of keys){ const r=await pool.query(`SELECT COUNT(*)::int n FROM ${k}`); out[k]=r.rows[0].n; }
  res.json({ summary: out });
});
router.get('/products', async (req,res)=>{ const r=await pool.query('SELECT * FROM products ORDER BY created_at DESC'); res.json({products:r.rows}); });
router.post('/products', async (req,res)=>{
  const b=req.body; const id=(b.id || productIdFromName(b.name)).trim(); if(!id||!b.name) return res.status(400).json({error:'Product id and name required'});
  const r=await pool.query(`INSERT INTO products (id,name,slug,category,type,price_cents,short_description,description,image_url,version,status,stripe_price_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [id,b.name,b.slug||id,b.category||'Website',b.type||'Website Files',Number(b.price_cents||0),b.short_description||'',b.description||'',b.image_url||'../assets/img/product-placeholder.svg',b.version||'1.0.0',b.status||'active',b.stripe_price_id||null]);
  await log(req,'created product','product',id,b); res.status(201).json({product:r.rows[0]});
});
router.patch('/products/:id', async (req,res)=>{
  const b=req.body;
  const r=await pool.query(`UPDATE products SET name=COALESCE($2,name), slug=COALESCE($3,slug), category=COALESCE($4,category), type=COALESCE($5,type), price_cents=COALESCE($6,price_cents), short_description=COALESCE($7,short_description), description=COALESCE($8,description), image_url=COALESCE($9,image_url), version=COALESCE($10,version), status=COALESCE($11,status), stripe_price_id=COALESCE($12,stripe_price_id), updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id,b.name,b.slug,b.category,b.type,b.price_cents===''?null:b.price_cents,b.short_description,b.description,b.image_url,b.version,b.status,b.stripe_price_id]);
  if(!r.rows[0]) return res.status(404).json({error:'Product not found'}); await log(req,'updated product','product',req.params.id,b); res.json({product:r.rows[0]});
});
router.delete('/products/:id', async(req,res)=>{ await pool.query('DELETE FROM products WHERE id=$1',[req.params.id]); await log(req,'deleted product','product',req.params.id); res.json({ok:true}); });
router.get('/customers', async(req,res)=>{ const r=await pool.query('SELECT id,name,email,role,status,created_at FROM users ORDER BY created_at DESC'); res.json({customers:r.rows}); });
router.patch('/customers/:id', async(req,res)=>{ const {name,role,status,password}=req.body; if(password){ await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(password,12),req.params.id]); }
 const r=await pool.query('UPDATE users SET name=COALESCE($2,name), role=COALESCE($3,role), status=COALESCE($4,status), updated_at=NOW() WHERE id=$1 RETURNING id,name,email,role,status,created_at',[req.params.id,name,role,status]); await log(req,'updated customer','user',req.params.id,req.body); res.json({customer:r.rows[0]}); });
router.get('/licenses', async(req,res)=>{ const r=await pool.query(`SELECT l.*, p.name product_name, u.email user_email FROM licenses l JOIN products p ON p.id=l.product_id LEFT JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC`); res.json({licenses:r.rows}); });
router.post('/licenses/generate', async(req,res)=>{ const {product_id,email,user_id,max_activations=1,expires_at,domain_lock,ip_lock,notes}=req.body; let uid=user_id||null; if(email&&!uid){ const u=await pool.query('SELECT id FROM users WHERE email=$1',[email.toLowerCase().trim()]); uid=u.rows[0]?.id||null; }
 if(!product_id) return res.status(400).json({error:'product_id required'}); const key=makeLicenseKey(); const r=await pool.query(`INSERT INTO licenses (license_key,product_id,user_id,max_activations,expires_at,domain_lock,ip_lock,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [key,product_id,uid,Number(max_activations||1),expires_at||null,domain_lock||null,ip_lock||null,notes||null,req.user.id]); await log(req,'generated license','license',r.rows[0].id,{product_id,email}); res.status(201).json({license:r.rows[0]}); });
router.patch('/licenses/:id/status', async(req,res)=>{ const r=await pool.query('UPDATE licenses SET status=$2, updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id,req.body.status]); await log(req,'changed license status','license',req.params.id,req.body); res.json({license:r.rows[0]}); });
router.patch('/licenses/:id', async(req,res)=>{ const b=req.body; const r=await pool.query(`UPDATE licenses SET status=COALESCE($2,status), max_activations=COALESCE($3,max_activations), domain_lock=$4, ip_lock=$5, expires_at=$6, notes=$7, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id,b.status,b.max_activations,b.domain_lock||null,b.ip_lock||null,b.expires_at||null,b.notes||null]); await log(req,'updated license','license',req.params.id,b); res.json({license:r.rows[0]}); });
router.get('/downloads', async(req,res)=>{ const r=await pool.query(`SELECT d.*, p.name product_name FROM downloads d JOIN products p ON p.id=d.product_id ORDER BY d.created_at DESC`); res.json({downloads:r.rows}); });
router.post('/downloads', async(req,res)=>{ const b=req.body; if(!b.product_id||!b.file_name||!b.file_url) return res.status(400).json({error:'product_id, file_name, file_url required'}); const r=await pool.query(`INSERT INTO downloads (product_id,version,file_name,file_url,changelog,is_latest) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [b.product_id,b.version||'1.0.0',b.file_name,b.file_url,b.changelog||'',b.is_latest!==false]); await log(req,'created download','download',r.rows[0].id,b); res.status(201).json({download:r.rows[0]}); });
router.patch('/downloads/:id', async(req,res)=>{ const b=req.body; const r=await pool.query(`UPDATE downloads SET product_id=COALESCE($2,product_id), version=COALESCE($3,version), file_name=COALESCE($4,file_name), file_url=COALESCE($5,file_url), changelog=COALESCE($6,changelog), is_latest=COALESCE($7,is_latest) WHERE id=$1 RETURNING *`, [req.params.id,b.product_id,b.version,b.file_name,b.file_url,b.changelog,b.is_latest]); res.json({download:r.rows[0]}); });
router.delete('/downloads/:id', async(req,res)=>{ await pool.query('DELETE FROM downloads WHERE id=$1',[req.params.id]); res.json({ok:true}); });
router.get('/activations', async(req,res)=>{ const r=await pool.query(`SELECT a.*, p.name product_name, l.license_key, u.email user_email FROM license_activations a JOIN products p ON p.id=a.product_id JOIN licenses l ON l.id=a.license_id LEFT JOIN users u ON u.id=l.user_id ORDER BY a.last_checked_at DESC`); res.json({activations:r.rows}); });
router.get('/invoices', async(req,res)=>{ const r=await pool.query(`SELECT i.*, p.name product_name, u.email user_email FROM invoices i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN users u ON u.id=i.user_id ORDER BY i.created_at DESC`); res.json({invoices:r.rows}); });
router.post('/invoices', async(req,res)=>{ const b=req.body; const r=await pool.query(`INSERT INTO invoices (invoice_number,user_id,product_id,license_id,amount_cents,status,provider,provider_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [b.invoice_number||invoiceNumber(),b.user_id||null,b.product_id||null,b.license_id||null,Number(b.amount_cents||0),b.status||'paid',b.provider||'manual',b.provider_reference||null]); res.status(201).json({invoice:r.rows[0]}); });
router.get('/support', async(req,res)=>{ const r=await pool.query(`SELECT t.*, u.email user_email FROM support_tickets t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC`); res.json({tickets:r.rows}); });
router.patch('/support/:id', async(req,res)=>{ const r=await pool.query('UPDATE support_tickets SET status=COALESCE($2,status), priority=COALESCE($3,priority), updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id,req.body.status,req.body.priority]); res.json({ticket:r.rows[0]}); });
router.get('/logs', async(req,res)=>{ const r=await pool.query(`SELECT l.*, u.email admin_email FROM admin_logs l LEFT JOIN users u ON u.id=l.admin_id ORDER BY l.created_at DESC LIMIT 250`); res.json({logs:r.rows}); });
module.exports = router;
