// Settle every started operation before rejecting, so no background unlink can
// outlive its deletion record or touch a closed database. Stop assigning more
// work after the first failure; the durable manifest supports a safe retry.
export async function deletionWork(items, operation, concurrency=8) {
  let next=0,failure;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(!failure&&next<items.length){const index=next++;try{await operation(items[index],index);}catch(error){failure??=error;}}
  }));
  if(failure)throw failure;
}
