# Blender side of scripts/blender-check.ts: imports each exported glTF, prints what Blender made of it, optionally
# edits it, and exports it back as GLB and as glTF Separate (Blender's own defaults otherwise).
# Usage: blender -b --factory-startup --python scripts/blender/roundtrip.py -- <jobs.json>
# jobs.json: [{ "gltf": in, "glb": out.glb, "sep": out.gltf, "edit": {"scale": [obj, f], "move": [obj, dy], "red": image} }]
import bpy
import json
import sys


def stats():
    objs = [o for o in bpy.data.objects if o.type == 'MESH']
    arm = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    return {
        'objects': len(objs),
        'names': sorted(o.name for o in objs),
        'vertices': sum(len(o.data.vertices) for o in objs),
        'triangles': sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs),
        'uv_layers': {o.name: len(o.data.uv_layers) for o in objs},
        'armatures': len(arm),
        'bones': sum(len(a.data.bones) for a in arm),
        'vertex_groups': sum(len(o.vertex_groups) for o in objs),
        'materials': sorted(m.name for m in bpy.data.materials if m.users),
        'images': sorted(i.name for i in bpy.data.images if i.users and i.type == 'IMAGE'),
        'empties': len([o for o in bpy.data.objects if o.type == 'EMPTY']),
        'shape_keys': sorted({k.name for o in objs if o.data.shape_keys for k in o.data.shape_keys.key_blocks[1:]}),
    }


def edit(e):
    if 'scale' in e:
        name, f = e['scale']
        o = bpy.data.objects[name]
        o.scale = (o.scale[0] * f, o.scale[1] * f, o.scale[2] * f)
    if 'move' in e:
        # moves the upper half of an object's vertices up (Blender Z) — in every shape key, as editing the basis in
        # Edit Mode does (with shape keys, the mesh's own coordinates are not what is exported)
        name, dz = e['move']
        o = bpy.data.objects[name]
        keys = list(o.data.shape_keys.key_blocks) if o.data.shape_keys else None
        base = keys[0].data if keys else o.data.vertices
        zs = sorted(v.co.z for v in base)
        mid = zs[len(zs) // 2]
        chosen = [i for i, v in enumerate(base) if v.co.z > mid]
        for data in ([k.data for k in keys] if keys else [o.data.vertices]):
            for i in chosen:
                data[i].co.z += dz
        o.data.update()
        print('MOVED %d vertices of %s (%d shape keys)' % (len(chosen), name, len(keys or [])))
    if 'red' in e:
        # fills the top-left quarter of an image with opaque red
        img = bpy.data.images[e['red']]
        w, h = img.size
        px = list(img.pixels)
        for y in range(h // 2, h):  # Blender images start at the bottom row
            for x in range(0, w // 2):
                i = (y * w + x) * 4
                px[i:i + 4] = [1.0, 0.0, 0.0, 1.0]
        img.pixels = px
        img.update()
        print('RED %s %dx%d' % (img.name, w, h))


jobs = json.load(open(sys.argv[sys.argv.index('--') + 1]))
for job in jobs:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    print('IMPORT ' + job['gltf'])
    result = bpy.ops.import_scene.gltf(filepath=job['gltf'])
    print('RESULT ' + json.dumps({'gltf': job['gltf'], 'op': list(result), 'stats': stats()}))
    if job.get('edit'):
        edit(job['edit'])
    if job.get('glb'):
        bpy.ops.export_scene.gltf(filepath=job['glb'], export_format='GLB')
        print('EXPORTED ' + job['glb'])
    if job.get('sep'):
        bpy.ops.export_scene.gltf(filepath=job['sep'], export_format='GLTF_SEPARATE')
        print('EXPORTED ' + job['sep'])
    if job.get('tangents'):
        # Blender's own MikkTSpace tangents: their handedness must agree with the game's (tangent convention check)
        bpy.ops.export_scene.gltf(filepath=job['tangents'], export_format='GLB', export_tangents=True)
        print('EXPORTED ' + job['tangents'])
    if job.get('nomorph'):
        # without shape keys: the importer has to re-target the blend shapes itself
        bpy.ops.export_scene.gltf(filepath=job['nomorph'], export_format='GLB', export_morph=False)
        print('EXPORTED ' + job['nomorph'])
    if job.get('emb'):
        # (Blender 4.2+ offers glTF Embedded only when enabled in the add-on's preferences)
        try:
            bpy.ops.export_scene.gltf(filepath=job['emb'], export_format='GLTF_EMBEDDED')
            print('EXPORTED ' + job['emb'])
        except Exception as e:
            print('SKIPPED glTF Embedded: %s' % str(e).splitlines()[0])
