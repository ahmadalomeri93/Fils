const clean = value => String(value ?? '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
const key = value => clean(value).replace(/[\sـ:]/g, '');
const amount = /^-?\d[\d,]*\.\d{3}$/;
const datePattern = /^\d{4}\/\d{2}\/\d{2}$/;
const toFils = value => {
  const n = Number(clean(value).replaceAll(',', '')) * 1000;
  if (!Number.isFinite(n) || Math.abs(n - Math.round(n)) > 0.0001 || !Number.isSafeInteger(Math.round(n))) throw new Error('مبلغ غير صالح في كشف PDF.');
  return Math.round(n);
};

function descriptionText(items) {
  const lines = [];
  for (const item of [...items].sort((a,b) => a.y-b.y || a.x-b.x)) {
    let line = lines.find(line => Math.abs(line.y-item.y)<2);
    if (!line) { line={y:item.y,items:[]}; lines.push(line); }
    line.items.push(item);
  }
  return lines.map(line => {
    const rtl = line.items.some(item => item.dir === 'rtl');
    // Arabic PDF items already contain logical text. Order items from right to left,
    // preserving adjacent Latin runs in their original left-to-right order.
    const groups=[];
    for (const item of line.items.sort((a,b)=>a.x-b.x)) {
      const previous=groups.at(-1);
      if (item.dir!=='rtl' && previous?.latin) previous.items.push(item);
      else groups.push({latin:item.dir!=='rtl',items:[item]});
    }
    if (rtl) groups.reverse();
    return groups.map(group=>group.items.map(item=>item.text).join(' ')).join(' ');
  }).join(' ').replace(/\s+/g,' ').trim();
}

export function extractStatementPage(content, pageNumber, height) {
  const items = content.items.filter(item => typeof item.str==='string' && clean(item.str)).map(item => ({
    text:clean(item.str), dir:item.dir, x:item.transform[4], y:height-item.transform[5], width:item.width
  }));
  if (!items.length) throw new Error('هالـPDF صور ممسوحة؛ نحتاج كشف PDF نصي من تطبيق حسابك.');
  const headers = Object.fromEntries(['مدين','دائن','الرصيد','التاريخ','الوصف'].map(name=>[name,items.find(item=>key(item.text)===name)]));
  if (Object.values(headers).some(item=>!item)) throw new Error(`تنسيق كشف PDF غير مدعوم في الصفحة ${pageNumber}. المدعوم حالياً كشف الحساب النصي بالعربي.`);
  const center=item=>item.x+item.width/2;
  const debitCenter=center(headers['مدين']);
  const creditCenter=center(headers['دائن']);
  const balanceCenter=center(headers['الرصيد']);
  const descriptionStart=debitCenter+(debitCenter-creditCenter)/2;
  const dateStart=headers['التاريخ'].x-30;
  const dates=items.filter(item=>datePattern.test(item.text) && item.x>=dateStart && item.y>headers['التاريخ'].y+5 && item.y<height*.88).sort((a,b)=>a.y-b.y);
  if (!dates.length) throw new Error(`ما لقينا عمليات واضحة في الصفحة ${pageNumber}.`);
  const stop=items.filter(item=>item.y>dates.at(-1).y && /إج.*مالي|الرصيدالمتوفر|الشيكاتالمدفوعة/.test(key(item.text))).map(item=>item.y);
  const endY=Math.min(height*.88,...stop);
  return dates.map((date,index)=>{
    const rowItems=items.filter(item=>item.y>=date.y-2 && item.y<((dates[index+1]?.y ?? endY)-2));
    const numbers=rowItems.filter(item=>Math.abs(item.y-date.y)<2 && item.x<descriptionStart && amount.test(item.text));
    const cells={Debit:[],Credit:[],Balance:[]};
    for (const item of numbers) {
      const nearest=[['Debit',debitCenter],['Credit',creditCenter],['Balance',balanceCenter]].sort((a,b)=>Math.abs(center(item)-a[1])-Math.abs(center(item)-b[1]))[0][0];
      cells[nearest].push(item.text.replaceAll(',',''));
    }
    if (cells.Balance.length!==1 || cells.Debit.length+cells.Credit.length!==1 || cells.Debit.length>1 || cells.Credit.length>1) throw new Error(`تعذر فصل المدين والدائن في الصفحة ${pageNumber}؛ لم نضف أي عملية.`);
    const description=descriptionText(rowItems.filter(item=>item.x>=descriptionStart && item.x<dateStart));
    if (!description) throw new Error(`وصف عملية غير واضح في الصفحة ${pageNumber}.`);
    return {Date:date.text.replaceAll('/','-'),Description:description,Debit:cells.Debit[0]??'',Credit:cells.Credit[0]??'',Balance:cells.Balance[0],Currency:'KWD'};
  });
}

export function validateStatementBalances(rows) {
  if (!rows.length) throw new Error('ما لقينا عمليات في PDF.');
  const descending=rows[0].Date>=rows.at(-1).Date;
  for (let i=0;i<rows.length-1;i++) {
    const current=descending ? rows[i] : rows[i+1];
    const previous=descending ? rows[i+1] : rows[i];
    if (toFils(current.Balance)!==toFils(previous.Balance)+toFils(current.Credit||'0.000')-toFils(current.Debit||'0.000')) throw new Error('رصيد PDF ما يطابق حركة العمليات. لم نحفظ أي بيانات؛ جرّب كشف الحساب النصي الأصلي.');
  }
  return rows;
}

export function statementRowsToCSV(rows) {
  const columns=['Date','Description','Debit','Credit','Balance','Currency'];
  const escape=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  return [columns,...rows.map(row=>columns.map(column=>row[column]))].map(row=>row.map(escape).join(',')).join('\n');
}

export async function readPDFStatement(file, onProgress=()=>{}, signal) {
  const pdfjs=await import('./vendor/pdfjs/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.mjs',import.meta.url).href;
  const task=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),useSystemFonts:true,isEvalSupported:false});
  const abort=()=>{void task.destroy();};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted) { abort(); throw new Error('تم إلغاء قراءة الكشف.'); }
  try {
    const pdf=await task.promise;
    if(pdf.numPages>200) throw new Error('الكشف أكبر من 200 صفحة. ارفع كشفاً أقصر.');
    const rows=[];
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++) {
      if(signal?.aborted) throw new Error('تم إلغاء قراءة الكشف.');
      onProgress(pageNumber,pdf.numPages);
      const page=await pdf.getPage(pageNumber);
      const content=await page.getTextContent();
      rows.push(...extractStatementPage(content,pageNumber,page.getViewport({scale:1}).height));
      page.cleanup();
      if(rows.length>12000) throw new Error('الكشف يحتوي أكثر من 12000 عملية. ارفع فترة أقصر.');
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return statementRowsToCSV(validateStatementBalances(rows));
  } catch(error) {
    if(error?.name==='PasswordException') throw new Error('PDF محمي بكلمة مرور. نزّل نسخة غير محمية من تطبيق حسابك.');
    throw error;
  } finally {
    signal?.removeEventListener('abort',abort);
    await task.destroy();
  }
}
