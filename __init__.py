import server
from aiohttp import web
import torch
import folder_paths
import os, json, re
import numpy as np
import hashlib
from PIL import Image, ImageOps
from PIL.PngImagePlugin import PngInfo
from io import BytesIO
import base64
from aiohttp import web


@server.PromptServer.instance.routes.get("/composer/listimage")
async def list_images(self):
    p = os.path.dirname(os.path.realpath(__file__))
    file_path = os.path.join(p, "web", "public", "images")

    return web.json_response({"success": True, "files": os.listdir(file_path)})


@server.PromptServer.instance.routes.get("/composer/images")
async def list_all_images(req):
    pathquery = req.query.get("path")
    p = os.path.dirname(os.path.realpath(__file__))
    file_path = os.path.join(p, "web", "public", "images")
    if pathquery is not None:
        file_path = os.path.join(p, "web", "public", "images", pathquery)
    if os.path.exists(file_path):
        return web.json_response(
            {
                "success": True,
                "path": pathquery if pathquery else "",
                "files": [x for x in os.listdir(file_path)],
            }
        )
    else:
        return web.json_response({"success": False})


@server.PromptServer.instance.routes.post("/composer/upload")
async def upload_asset(request):
    post = await request.post()
    image = post.get("image")
    p = os.path.dirname(os.path.realpath(__file__))
    file_path = os.path.join(p, "web", "public", "images", image.filename)
    print(file_path)
    with open(file_path, "wb") as f:
        f.write(image.file.read())
    return web.json_response({"success": True})


@server.PromptServer.instance.routes.post("/composer/saveconfig")
async def saveconfig(request):
    post = await request.post()
    jsondata = json.loads(post.get("config_json"))
    filename = post.get("config_name")
    p = os.path.dirname(os.path.realpath(__file__))
    file_path = os.path.join(p, "web", "public", "config", filename)
    with open(file_path, "w") as f:
        f.write(json.dumps(jsondata, indent=4))
    return web.json_response({"success": True, "data": jsondata})


@server.PromptServer.instance.routes.get("/composer/loadconfig")
async def getconfig(req):
    configname = req.query.get("config_name")
    p = os.path.dirname(os.path.realpath(__file__))
    file_path = os.path.join(p, "web", "public", "config", configname)
    if not os.path.isfile(file_path):
        return web.json_response({"success": False, "data": None})
    result = ""
    with open(file_path) as f:
        result = json.load(f)
    return web.json_response({"success": True, "data": result})


class ImageComposer:
    def __init__(self):
        print("init comfyshop")

    @classmethod
    def IS_CHANGED(self, image, extra_pnginfo, unique_id):
        global base64image
        for node in extra_pnginfo["workflow"]["nodes"]:
            if node["id"] == int(unique_id):
                base64image = node["properties"]["imagebase64"]
                break
        image_data = base64.b64decode(base64image.split(",")[1])

        m = hashlib.sha256()
        m.update(bytes(image_data, "utf-8"))
        return m.digest().hex()

    @classmethod
    def INPUT_TYPES(s):
        work_dir = folder_paths.get_input_directory()
        images = [
            img
            for img in os.listdir(work_dir)
            if os.path.isfile(os.path.join(work_dir, img))
        ]
        return {
            "required": {"image": (sorted(images),)},
            "hidden": {"extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"},
        }

    CATEGORY = "😶‍🌫️Image Composer"

    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "load_image"

    def load_image(self, image, extra_pnginfo, unique_id):
        global base64image
        for node in extra_pnginfo["workflow"]["nodes"]:
            if node["id"] == int(unique_id):
                base64image = node["properties"]["imagebase64"]
                break
        image_data = base64.b64decode(base64image.split(",")[1])

        i = Image.open(BytesIO(image_data))
        i = ImageOps.exif_transpose(i)
        image = i.convert("RGB")
        image = np.array(image).astype(np.float32) / 255.0
        image = torch.from_numpy(image)[None,]
        if "A" in i.getbands():
            mask = np.array(i.getchannel("A")).astype(np.float32) / 255.0
            mask = 1.0 - torch.from_numpy(mask)
        else:
            mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
        return (image, mask.unsqueeze(0))


NODE_CLASS_MAPPINGS = {
    "Image Composer": ImageComposer,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "Image Composer": "Image Composer",
}
WEB_DIRECTORY = "./web"
