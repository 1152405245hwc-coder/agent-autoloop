import {existsSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {HOME} from "./home.ts";

export async function loadPlugin(name:string,kind:"agent"|"channel"|"source") {
  if(!/^[a-z][a-z0-9-]*$/.test(name))throw new Error(`插件名字不正确：${name}`);
  const file=[join(HOME,"plugins",name,`${kind}.ts`),join(import.meta.dirname,"..","plugins",name,`${kind}.ts`)].find(existsSync);
  if(!file)throw new Error(`没有 ${name} 的插件（plugins/${name}/${kind}.ts）`);
  return (await import(pathToFileURL(file).href)).default;
}
