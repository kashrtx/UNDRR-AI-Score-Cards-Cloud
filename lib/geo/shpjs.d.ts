// shpjs ships without type declarations; this covers the one call we make.
declare module "shpjs" {
  const shp: (input: ArrayBuffer | string) => Promise<unknown>;
  export default shp;
}
