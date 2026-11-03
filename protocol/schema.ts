import {readFileSync} from "node:fs";
import {dateTime} from "./validate.ts";
export const schemas=JSON.parse(readFileSync(new URL("./schema.json",import.meta.url),"utf8"));

export function checkSchema(name:string,value:unknown):string[] {
  const visit=(schema:any,item:any,path:string):string[]=>{
    if(schema.$ref)return visit(schemas.$defs[schema.$ref.split("/").at(-1)],item,path);
    if(schema.anyOf&&!schema.anyOf.some((s:any)=>visit(s,item,path).length===0))return [path];
    if(schema.oneOf&&schema.oneOf.filter((s:any)=>visit(s,item,path).length===0).length!==1)return [path];
    if(schema.const!==undefined&&item!==schema.const||schema.enum&&!schema.enum.includes(item))return [path];
    const types=Array.isArray(schema.type)?schema.type:[schema.type];
    const matches=(t:string)=>t==="object"?item!==null&&typeof item==="object"&&!Array.isArray(item):t==="array"?Array.isArray(item):t==="integer"?Number.isSafeInteger(item):t==="null"?item===null:typeof item===t;
    if(schema.type&&!types.some(matches))return [path];
    if(typeof item==="string"&&(schema.minLength!==undefined&&[...item].length<schema.minLength||schema.maxLength!==undefined&&[...item].length>schema.maxLength||schema.pattern&&!new RegExp(schema.pattern,"u").test(item)))return [path];
    if(schema.format==="date-time"&&!dateTime(item))return [path];
    if(typeof item==="number"&&(!Number.isFinite(item)||schema.minimum!==undefined&&item<schema.minimum||schema.maximum!==undefined&&item>schema.maximum))return [path];
    if(Array.isArray(item))return schema.minItems!==undefined&&item.length<schema.minItems||schema.maxItems!==undefined&&item.length>schema.maxItems?[path]:item.flatMap((v,i)=>schema.items?visit(schema.items,v,`${path}[${i}]`):[]);
    if(item!==null&&typeof item==="object") {
      const errors=(schema.required??[]).filter((key:string)=>!Object.hasOwn(item,key)).map((key:string)=>`${path}.${key}`);
      for(const [key,v] of Object.entries(item)){const child=Object.hasOwn(schema.properties??{},key)?schema.properties[key]:undefined;if(child)errors.push(...visit(child,v,`${path}.${key}`));else if(schema.additionalProperties===false)errors.push(`${path}.${key}`);else if(typeof schema.additionalProperties==="object")errors.push(...visit(schema.additionalProperties,v,`${path}.${key}`));}
      return errors;
    }
    return [];
  };
  if(!Object.hasOwn(schemas.$defs,name))throw new Error(`没有这个协议类型：${name}`);
  return visit(schemas.$defs[name],value,name);
}
