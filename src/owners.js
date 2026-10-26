// Only trusted webhook senders or stored job/session owners may select a scope.
export const primaryOwner=env=>env.PRIMARY_OWNER??env.ALLOWED_SENDER;
export function configuredOwners(env){
 const primary=primaryOwner(env),extra=JSON.parse(env.ALLOWED_SENDERS??'[]');
 if(!Array.isArray(extra)||extra.length>20||![primary,...extra].every(n=>typeof n==='string'&&/^\d{6,15}$/.test(n)))throw new Error('invalid_owner_configuration');
 return [...new Set([primary,...extra])];
}
export function resolveOwner(env,sender){return typeof sender==='string'&&configuredOwners(env).includes(sender)?sender:null;}
export function ownerEnv(env,owner){
 if(!resolveOwner(env,owner))throw new Error('owner_not_allowed');
 return {...env,PRIMARY_OWNER:primaryOwner(env),ALLOWED_SENDER:owner};
}
