import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js"
import { $el } from "/scripts/ui.js";

const ROOTDIR = '/extensions/ImageComposer/public';
const HISTORY = "icomp_layer_history";



function log(...message) {
    console.warn("comfyshop.imagecomposer", ...message);
}

function CUSTOM_INT(node, inputName, val, func, config = {}) {
    return {
        widget: node.addWidget('number', inputName, val, func, Object.assign({}, { min: 0, max: 4096, step: 640, precision: 0 }, config)),
    };
}

function blobToBase64(blob) {
    return new Promise((resolve, _) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

function computeCanvasSize(node, size) {
    if (node.widgets[0].last_y == null) return;
    const MIN_SIZE = 200;

    let y = LiteGraph.NODE_WIDGET_HEIGHT * node.outputs.length + 5;
    let freeSpace = size[1] - y;

    // Compute the height of all non customtext widgets
    let widgetHeight = 0;
    for (let i = 0; i < node.widgets.length; i++) {
        const w = node.widgets[i];
        if (w.type !== "composer_canvas") {
            if (w.computeSize) {
                widgetHeight += w.computeSize()[1] + 4;
            } else {
                widgetHeight += LiteGraph.NODE_WIDGET_HEIGHT + 5;
            }
        }
    }

    // See how large the canvas can be
    freeSpace -= widgetHeight;

    // There isnt enough space for all the widgets, increase the size of the node
    if (freeSpace < MIN_SIZE) {
        freeSpace = MIN_SIZE;
        node.size[1] = y + widgetHeight + freeSpace;
        node.graph.setDirtyCanvas(true);
    }

    // Position each of the widgets
    for (const w of node.widgets) {
        w.y = y;
        if (w.type === "customCanvas") {
            y += freeSpace;
        } else if (w.computeSize) {
            y += w.computeSize()[1] + 4;
        } else {
            y += LiteGraph.NODE_WIDGET_HEIGHT + 4;
        }
    }

    node.canvasHeight = freeSpace + -20;
    return y
}

class IMComposer {

    STATE = {
        Normal: 0,
        Selected: 1,
        Hidden: 2,
        MaskMode: 3,
        FreeDraw: 4,
        TextLayer: 5,
    }

    constructor(node, canvas, id) {
        this.id = id;
        this.node = node;
        this.canvaswidth = 512;
        this.canvasheight = 512;
        this.icomp_menu_container;
        this.icomp_stage_container;
        this.icomp_stage;
        this.icomp_layers_container;
        this.imagecomposer_node = null;
        this.show_menu = true;
        this.timeoutId;

        this.isPaint = false;
        this.currentMaskLayer = null;
        this.lastPointerPosition
        this.currentMaskContext
        this.currentMaskImg
        this.brushCircle;
        this.brushLayer;
        this.maskMode = false;
        this.colorpicker;
        this.brushSize = 10;
        this.icomp_stage;
        this.add_button;
        this.imageslib_container;
        this.stageEventNotifier = false;
        this.dialog_container;
        this.layer_state = 0;
        this.brushColor = "#ffdd00";
        this.contextMenu;
        this.canvasPosition;
        this.composition;
        this.layersData = [];
        this.imagesList;
        this.timeoutId;
        this.timeout = 3000;
        this.selectedLayer = null;
        this.isAnchorShown = false;
        this.layerScale = 1;
        this.canvas = this.initCanvas(canvas);
        this.currentFolder = "root";
        this.statusbar;
        this.default_statusbar = "hover on button to show what it do. or click me to show/hide the menus..."
        this.config_file = id;


    }

    initCanvas(canvas) {
        canvas = document.createElement("div");
        canvas.className = "icomp_container";
        canvas.id = this.id;
        return canvas;
    }
    //setting up interface
    async addElements() {
        var self = this;
        this.node.setProperty("width", this.canvaswidth)
        this.node.setProperty("height", this.canvasheight)
        this.node.setProperty("imagebase64", "null");
        this.node.serialize_widgets = true;

        CUSTOM_INT(this.node, "width", this.canvaswidth, function (v, _, node) {
            const s = this.options.step / 10;
            this.value = Math.round(v / s) * s;
            node.properties["width"] = this.value;
        });

        CUSTOM_INT(this.node, "height", this.canvasheight, function (v, _, node) {
            const s = this.options.step / 10; this.value = Math.round(v / s) * s;
            node.properties["height"] = this.value;

        });

        this.icomp_stage_container = $el("div.icomp_stage_container", { parent: document.body });
        this.icomp_menu_container = $el("div.icomp_menu_container", { parent: document.body });
        this.menu_btn_container = $el("div.icomp_menu_button_kontainer", { parent: this.icomp_menu_container });
        this.add_button = $el("div.icomp_menu_button", { textContent: "➕", parent: this.menu_btn_container });
        this.icomp_layers_container = $el("div.icomp_menu_layer_container", { parent: document.body });
        const drawing_layer = $el("div.layer_item_menu_drawing_layer.icomp_menu_button", { textContent: "🪱", parent: this.menu_btn_container });
        this.colorpicker = $el("input.layer_item_menu_colorpicker", { type: "color", value: self.brushColor, parent: this.menu_btn_container });
        const force_update = $el("div.layer_item_force_update.icomp_menu_button", { textContent: "💦", parent: this.menu_btn_container });
        this.dialog_container = $el("div.dialog_container", { id: `dialog_parent_${this.id}`, parent: document.body }, [
            $el("div.dialog_dropzone", {}, [
                $el("div.dialog_dropzone_text", { textContent: "Drop here..." })
            ])
        ]);

        this.imageslib_container = $el("div.icomp_images_parent", { id: `image_loader_${this.id}`, parent: this.dialog_container });
        this.statusbar = $el("div.icomp_statusbar", { textContent: "Initiating. please wait", parent: this.icomp_stage_container });
        this.statusbar.addEventListener("click", () => { this.show_menu = !this.show_menu; this.node.setDirtyCanvas(true) }, false);
        this.dialog_container.addEventListener("click", () => {
            self.imageslib_container.classList.add('dialoghide');
            this.dialog_container.style.pointerEvents = "none";
        })
        this.colorpicker.addEventListener("change", (e) => {
            self.brushColor = e.target.value;
            if (self.currentMaskContext)
                self.currentMaskContext.strokeStyle = self.brushColor;
        })
        this.icomp_stage_container.appendChild(this.canvas);

        force_update.addEventListener("click", () => {

            self.deselectAll();
            this.updateLayers();
            self.icomp_stage.toBlob({}).then(async (result) => {
                const w = await blobToBase64(result);
                self.node.properties["imagebase64"] = w;
                self.saveKonvaCanvasInfo();

            });
        });

        this.add_button.addEventListener("click", () => {
            if (!this.imageslib_container) return;
            this.dialog_container.style.pointerEvents = "all";
            this.imageslib_container.classList.add("dialogshow")

        });

        drawing_layer.addEventListener("click", () => {

            self.addLayer(undefined, undefined, true);
        })

        this.imageslib_container.addEventListener("webkitAnimationEnd", () => {
            if (this.imageslib_container.classList.contains("dialogshow")) {
                this.imageslib_container.classList.remove("dialogshow")
                this.imageslib_container.style.transform = "scale(100%,100%)";
            }
            if (this.imageslib_container.classList.contains("dialoghide")) {
                this.imageslib_container.classList.remove("dialoghide")
                this.imageslib_container.style.transform = "scale(0%,0%)";
            }
        });


        this.icomp_stage = new Konva.Stage({
            container: this.id,
            width: this.canvaswidth,
            height: this.canvasheight,
        });

        this.icomp_stage?.on("dblclick", async (e) => {
            //this.commitChanged();


        });

        this.brushCircle = new Konva.Circle({
            x: 80,
            y: 120,
            radius: this.brushSize / 2,
            stroke: "white",
            strokeWidth: .5,
            dash: [3, 3],
            listening: false,
        });

        this.brushCircle.lineCap("round");
        this.brushLayer = new Konva.Layer();
        this.brushLayer.add(this.brushCircle);
        this.icomp_stage.add(this.brushLayer);
        this.brushLayer.hide();

        this.initContextMenu();
        this.initEventListener();
        this.loadConfig();
        this.updateStatusbar("Let's go...")

    }

    updateStatusbar(message) {
        this.statusbar.textContent = message;
    }

    async loadImages() {
        await this.fetchImages();
    }

    async fetchImages(path = "") {
        var self = this;
        const response = await api.fetchApi("/composer/images?path=" + path);

        const result = response.ok ? await response.json() : null;
        if (result && result.success) {
            while (self.imageslib_container.firstChild) {
                self.imageslib_container.removeChild(self.imageslib_container.firstChild)
            }
            let folder = []
            const folder_parent_container = $el("div.folder_parent_container");
            result.files.forEach((file) => {
                if (file.split(".").length <= 1) {
                    folder.push(file);
                } else {
                    const url = `${ROOTDIR}/images/${path != '' ? path + "/" : ""}` + file;


                    const image = $el("img.image_layer", { src: url });
                    self.imageslib_container.append(image);
                    image.addEventListener("click", () => {
                        self.imageslib_container.classList.add('dialoghide');
                        const filewithpath = path != '' ? path + "/" + file : file;
                        self.addLayer(filewithpath);
                    })
                }
            });
            if (folder.length) {
                for (const folder_path of folder) {
                    const f = $el("div.folder_parent", { parent: folder_parent_container }, [
                        $el("img.folder_icon", { src: `${ROOTDIR}` + "/asset/folder_icon.png" }),
                        $el("div.folder_name", { textContent: folder_path })]);
                    self.imageslib_container.prepend(folder_parent_container);
                    f.addEventListener("click", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.fetchImages(folder_path);
                        self.currentFolder = folder_path
                    })
                }
                if (path != "") {
                    this.makeRootFolder(folder_parent_container)
                }

            } else {
                this.makeRootFolder(folder_parent_container)
            }


        }

    }

    async addLayer(image_name, config, freedraw) {
        let self = this;
        let layer, image, maskcontext, maskimage, canvas;
        let thename = image_name ? image_name : "";
        const idx = config ? config.index : self.icomp_layers_container.children.length + 1;
        //load config

        if (config) {

            if (config.freedraw) {
                [layer, image, maskcontext, maskimage, canvas] = await self.addImageToCanvas(
                    { id: config.id, name: config.name, freedraw: true },
                    null,
                    null,
                    null,
                    config.maskBase64Image
                );
            } else

                [layer,
                    image,
                    maskcontext,
                    maskimage,
                    canvas]
                    = await self.addImageToCanvas(
                        { id: config.id, name: config.name, index: config.index },
                        config.position,
                        config.scale, config.rotation, config.maskBase64Image);
        }
        else {
            if (!freedraw)
                [layer, image, maskcontext, maskimage, canvas] = await self.addImageToCanvas(
                    { id: self.icomp_layers_container.children.length + 1, name: image_name }
                );
            else {

                thename = `freedraw_${self.icomp_layers_container.children.length + 1}`;
                [layer, image, maskcontext, maskimage, canvas] = await self.addImageToCanvas(
                    { id: self.icomp_layers_container.children.length + 1, name: thename, freedraw: freedraw }
                );

            }
        }
        if (self.icomp_layers_container.children.length < 1) {
            const sortable = Sortable.create(self.icomp_layers_container, {
                animation: 100,
                sort: true,
                emptyInsertThreshold: 0,
                onSort: (e) => {
                    const otherlayers = self.icomp_stage.getChildren().filter(cl => cl.getClassName() === "Layer");
                    const so = sortable.toArray();

                    const domlayer = Array.from(self.icomp_layers_container.children);
                    domlayer.sort((a, b) => so.indexOf(a.dataset.index) - so.indexOf(b.dataset.index)).map((dl, di) => {
                        dl.dataset.index = di;
                    })
                    otherlayers.sort((a, b) => so.indexOf(a._id.toString()) - so.indexOf(b._id.toString())).map((sLayer, sIndex) => {

                        sLayer.zIndex(sIndex);
                    })
                },

            });
        }

        const content = {
            id: layer._id,
            name: thename,
            index: idx,
            layerStateVisible: true,
            freedraw: freedraw
        }


        const layer_item = $el("div.layer_item", { parent: self.icomp_layers_container, dataset: content });
        const visible_layer = $el("div.layer_item_visible.icomp_menu_button", { textContent: "⚪", parent: layer_item });
        const masked_layer = $el("div.layer_item_mask.icomp_menu_button", { textContent: "🖌️", parent: layer_item });
        const delete_layer = $el("div.layer_item_close.icomp_menu_button", { textContent: "❌", parent: layer_item });
        const invertmask = $el("div.layer_item_invert_mask.icomp_menu_button", { textContent: "💢", parent: layer_item });

        [visible_layer, masked_layer, delete_layer, invertmask].forEach((el, idx) => {
            el.add
        })
        Object.keys(content).map(e => { layer_item.setAttribute(`data-${e.replace(/[A-Z]/g, x => `-${x.toLowerCase()}`)}`, content[e]) })

        layer_item.dataset.positionX = layer.position().x;
        layer_item.dataset.positionY = layer.position().y;
        layer_item.dataset.scaleX = image.scale().x;
        layer_item.dataset.scaleY = image.scale().y;
        const layervisibility = config ? config.layerStateVisible : true;
        layer_item.dataset.layerStateVisible = layervisibility;
        const invertedMask = config ? config.invertedMask : true;
        layer_item.dataset.invertedMask = invertedMask;

        const data = { id: content.id, canvas: canvas, image: image, inverted_mask: invertedMask, layer: layer_item };
        this.layersData.push(data);

        setTimeout(() => {

            layervisibility ? layer.show() : layer.hide();
            layer_item.click();
        }, 300)
        $el("div.layer_item_name", { textContent: content.name, parent: layer_item });
        invertmask.addEventListener("click", (e) => {
            e.stopPropagation();
            const inverted = !(layer_item.dataset.invertedMask === 'true');
            maskimage.globalCompositeOperation(inverted ? "destination-in" : "destination-out")
            layer_item.dataset.invertedMask = inverted;

        })
        visible_layer.addEventListener("click", (e) => {
            e.stopPropagation();
            self.brushLayer.hide();
            layer.isVisible() ? layer.hide() : layer.show();
            layer_item.dataset.layerStateVisible = layer.isVisible();
            layer_item.dataset.layerState = this.STATE.Hidden;
            this.updateLayers();
        })
        layer_item.addEventListener("click", () => {
            self.deselectAll();
            if (freedraw) {
                self.layerScale = 1;
                layer.draggable(false);
                layer.listening(true);
                self.brushLayer.show();
                self.maskMode = true;
                self.currentMaskLayer = layer;
                self.currentMaskContext = maskcontext;
                self.currentMaskImg = maskimage;
                const tr = layer.getChildren().filter(cl => cl.getClassName() == "Transformer")[0];
                tr.nodes([]);
                layer_item.dataset.layerState = this.STATE.FreeDraw;
                this.updateLayers();
                if (!self.stageEventNotifier)
                    self.konvaStageEvent();
            } else {
                self.brushLayer.hide();
                layer.draggable(true);
                layer.listening(true);
                self.maskMode = false;
                const children = layer.getChildren();
                const tr = children.filter(cl => cl.getClassName() == "Transformer")[0];
                const images = children.filter(cl => cl.getClassName() == "Image");
                tr.nodes(images);
                layer_item.dataset.layerState = this.STATE.Selected;
                this.updateLayers();

            }
            self.selectedLayer = layer;

        });
        masked_layer.addEventListener("click", (e) => {
            e.stopPropagation();
            self.brushLayer.show();
            self.maskMode = true;
            layer_item.style.background = "#1f42ff";
            layer.draggable(false);
            layer.listening(true);
            const tr = layer.getChildren().filter(cl => cl.getClassName() == "Transformer")[0];
            tr.nodes([]);
            self.currentMaskLayer = layer;
            self.currentMaskContext = maskcontext;
            self.currentMaskImg = maskimage;
            self.currentMaskContext.lineWidth = self.brushSize;
            layer_item.dataset.layerState = this.STATE.MaskMode;
            this.updateLayers();

            if (!self.stageEventNotifier)
                self.konvaStageEvent();

        })
        delete_layer.addEventListener("click", (e) => {
            e.stopPropagation();
            const index = self.layersData.findIndex(e => e.id === content.id);
            self.layersData.splice(index, 1);
            layer.remove();
            self.icomp_layers_container.removeChild(layer_item);


        })
        app.graph.setDirtyCanvas(true);
        self.brushLayer.moveToTop();

        if (config) {
            layer.zIndex(config.index);
        }
        this.updateLayers();

    }

    addImageToCanvas(
        content,
        position = { x: 0, y: 0 },
        scale,
        rotation = 0,
        maskBase64Image
    ) {
        var self = this;

        if (content.freedraw) {
            return new Promise((resolve, reject) => {
                const l = new Konva.Layer({

                    draggable: false,
                    listening: false,
                    name: "imagelayer"
                });
                const tr = new Konva.Transformer();

                const [_currentMaskContext, _img, _canvas] = this.FreeDrawLayer(this.icomp_stage.width(), this.icomp_stage.height(), maskBase64Image);
                l.add(_img);
                l.add(tr);
                tr.nodes([]);
                this.icomp_stage.add(l);
                // resolve([l, img, _currentMaskContext, _currentMaskImg, _canvas]);
                resolve([l, _img, _currentMaskContext, _img, _canvas]);

            })
        } else {

            const url = `${ROOTDIR}/images/` + content.name;
            return new Promise((resolve, reject) => {
                const l = new Konva.Layer({
                    x: position.x,
                    y: position.y,
                    draggable: false,
                    listening: false,
                    name: "imagelayer"
                });

                const tr = new Konva.Transformer({
                    shiftBehaviour: "inverted",
                    rotateEnabled: false,

                });

                const image = new Image();

                image.src = url;
                image.onload = () => {
                    if (!scale) {
                        const sc = self.calcWH(image.width, image.height, 512)
                        scale = { x: sc.width, y: sc.height }
                    }

                    const img = new Konva.Image({

                        scaleX: scale.x,
                        scaleY: scale.y,
                        width: image.width,
                        height: image.height,
                        image: image,
                        name: "image",
                    });
                    self.layerScale = img.scale()




                    const [_currentMaskContext, _currentMaskImg, _canvas] = this.LayerMask(img, content.name, maskBase64Image);
                    l.add(img);
                    l.add(_currentMaskImg);
                    l.add(tr);


                    l.on("dragend", (e) => {
                        let idx = self.layersData.findIndex(e => e.id == l._id);
                        self.updateLayerData(self.layersData[idx], img, l, tr);
                    })
                    l.on("dragstart", (e) => {

                        if (!this.isAnchorShown) {
                            self.showHideAnchor(true)
                        }
                    })

                    tr.on("transformend", (e) => {



                        let idx = self.layersData.findIndex(e => e.id == l._id);
                        self.updateLayerData(self.layersData[idx], img, l, tr);
                        self.layerScale = img.scale();




                    })

                    // attach a shape
                    tr.nodes([]);

                    this.icomp_stage.add(l);
                    resolve([l, img, _currentMaskContext, _currentMaskImg, _canvas]);
                };

            });
        }

    }

    LayerMask(image, name, maskBase64Image, inverted_mask) {
        self = this;
        let inverted;
        if (inverted_mask)
            inverted = inverted_mask;

        let canvas = document.createElement("canvas");
        canvas.width = image.width();
        canvas.height = image.height();

        const img = new Konva.Image({
            image: canvas,
            scaleX: image.scaleX(),
            scaleY: image.scaleY(),
            globalCompositeOperation: inverted ? "destination-in" : "destination-out",
            listening: true,
            name: "mask_" + name,
        });
        img.on("mousedown touchstart", (e) => {
            self.isPaint = true;
            if (self.currentMaskLayer != null && self.maskMode)
                self.lastPointerPosition = self.currentMaskLayer.getRelativePointerPosition();
        });

        img.on("mouseup touchend", function (e) {
            self.isPaint = false;


        });

        img.on("transformend", () => {
            self.currentMaskContext = img.image().getContext("2d");
            self.currentMaskImg = img;
        });

        let context = canvas.getContext("2d");
        var _maskimage = new Image();
        _maskimage.onload = function () {
            context.drawImage(_maskimage, 0, 0)
        }
        _maskimage.src = maskBase64Image;
        context.strokeStyle = "#ffffff";
        context.lineJoin = "round";
        context.lineWidth = self.brushSize;
        return [context, img, canvas];
    }

    FreeDrawLayer(width, height, maskBase64Image) {
        self = this;
        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const img = new Konva.Image({
            image: canvas,
            x: 0,
            y: 0,
            listening: true,
            name: "freedraw",
        });
        img.on("mousedown touchstart", (e) => {
            self.isPaint = true;
            if (self.currentMaskLayer != null && self.maskMode)
                self.lastPointerPosition = self.currentMaskLayer.getRelativePointerPosition();
        });

        img.on("mouseup touchend", function (e) {
            self.isPaint = false;

        });

        img.on("transformend", () => {
            self.currentMaskContext = img.image().getContext("2d");
            self.currentMaskImg = img;
        });


        let context = canvas.getContext("2d");

        if (maskBase64Image) {
            var _maskimage = new Image();
            _maskimage.onload = function () {
                context.drawImage(_maskimage, 0, 0)
            }
            _maskimage.src = maskBase64Image;
        }

        context.strokeStyle = this.brushColor;
        context.lineJoin = "round";
        context.lineWidth = self.brushSize;
        return [context, img, canvas];
    }


    initContextMenu() {
        var self = this;
        function onclick(e) {
            self.contextMenu.style.display = "none";
        }
        self.contextMenu = $el("div.icomp_contextmenu", { parent: document.body })
        const cancel_btn = $el("div.icomp_contextmenu_button", { parent: this.contextMenu, textContent: "paste clipspace", dataset: { mode: "url" } })
        const paste_button = $el("div.icomp_contextmenu_button", { parent: this.contextMenu, textContent: "paste clipboard", dataset: { mode: "clipspace" } })
        cancel_btn.addEventListener("click", onclick);
        paste_button.addEventListener("click", onclick);
        this.icomp_stage.on("contextmenu", (e) => {
            e.evt.preventDefault();
            self.contextMenu.style.display = "flex";
            var info = self.canvasPosition;
            var mp = self.icomp_stage.getRelativePointerPosition();


            var pos = {
                x:
                    mp.x * info.scale + (info.scale * 20),
                y:
                    mp.y * info.scale + (info.scale * 50)
            };
            self.contextMenu.style.top = `${e.evt.pageY}px`;
            self.contextMenu.style.left = `${e.evt.pageX}px`;

        })
        document.addEventListener("click", () => { self.contextMenu.style.display = "none" })
        document.addEventListener("keyup", (e) => { if (e.key == "Escape") self.contextMenu.style.display = "none" })
    }

    initEventListener() {
        var self = this;
        var dc = self.dialog_container.firstChild;
        var container = self.dialog_container;
        function noopHandler(evt) {
            evt.stopPropagation();
            evt.preventDefault();
            switch (evt.type) {
                case "dragover":
                    dc.style.display = "flex";
                    break;
                case "dragleave":
                    dc.style.display = "none";
                    break;

            }
        }
        function drop(evt) {
            evt.stopPropagation();
            evt.preventDefault();

            var files = evt.dataTransfer.files;
            for (const file of files) {
                const f = new FormData();
                f.append("image", file);
                api.fetchApi("/composer/upload", {
                    method: "POST",
                    body: f
                })
                    .then(response => { if (response.ok) return response.json() })
                    .then((result) => {
                        self.loadImages();
                    })
            }

            dc.style.display = "none";
        }

        container.addEventListener("dragover", noopHandler, false)
        dc.addEventListener("dragleave", noopHandler, false)
        dc.addEventListener("drop", drop, false)
        self.icomp_stage.on('mousedown mouseup mousemove', (e) => {
            self.autoSave();
        });
        this.autoSave();

        const buttons = [
            ".icomp_menu_button",
            ".layer_item_menu_drawing_layer",
            ".layer_item_menu_colorpicker",
            ".layer_item_force_update",
        ].map(sel => document.querySelector(sel))
        buttons.forEach((el, index) => {
            document
            el?.addEventListener("mouseover", (e) => {
                let msg = ""
                switch (index) {
                    case 0:
                        msg = "add image to canvas";
                        break;
                    case 1:
                        msg = "add freedraw layer"
                        break;
                    case 2:
                        msg = "pick color for freedraw layer"
                        break;
                    case 3:
                        msg = self.default_statusbar;
                        break;

                }
                self.updateStatusbar(msg)
            }, false)
            el?.addEventListener("mouseleave", (e) => self.updateStatusbar(self.default_statusbar), "false");
        })
        const layer_btn = [
            "layer_item_visible",
            "layer_item_mask",
            "layer_item_close",
            "layer_item_invert_mask"];

        self.icomp_layers_container.addEventListener("mouseover", (e) => {
            let msg = "...";
            switch (layer_btn.indexOf(e.target.classList[0])) {
                case 0:
                    msg = "show or hide current layer"
                    break;
                case 1:
                    msg = "enter mask_mode (for image layer)"
                    break;
                case 2:
                    msg = "delete layer"
                    break;
                case 3:
                    msg = "invert current layer mask"
                    break;
            }
            self.updateStatusbar(msg)
        })
        self.icomp_layers_container.addEventListener("mouseleave", (e) => {
            switch (layer_btn.indexOf(e.target.classList[0])) {
                default:

                    self.updateStatusbar(self.default_statusbar)
                    break;
            }
        })


    }

    autoSave() {
        var self = this;
        if (self.timeoutId) clearTimeout(this.timeoutId);
        self.timeoutId = setTimeout(() => {
            if (!self.icomp_stage) return;

            self.showHideAnchor(false);
        }, self.timeout);
    }
    scaleWidget(scale) {
        //?todo
    }

    showHideAnchor(show) {
        if (!this.selectedLayer) return;

        const d = { tranformer: null, images: [] }
        this.selectedLayer.getChildren().forEach((l) => {
            if (l.getClassName() == "Transformer")
                d.tranformer = l;
            if (l.getClassName() == "Image")
                d.images.push(l);
        })
        if (show) {
            d.tranformer.nodes(d.images)
            this.isAnchorShown = true;
            this.brushCircle.show();
        }
        else {
            d.tranformer.nodes([])
            this.brushCircle.hide();
            this.isAnchorShown = false;
            this.commitChanged();
        }
    }

    commitChanged() {

        //this.deselectAll();
        this.updateLayers();

        this.icomp_stage.toBlob({}).then(async (result) => {
            const w = await blobToBase64(result);
            this.node.properties["imagebase64"] = w;
            this.saveKonvaCanvasInfo();

        })
    }

    Delete() {
        this.icomp_stage_container.remove();
        this.icomp_menu_container.remove();
        this.icomp_layers_container.remove();
        this.dialog_container.remove();
    }

    UpdateLayerState(layer_item, index) {
        var state = layer_item.dataset.layerState;
        var stateVisible = layer_item.dataset.layerStateVisible;

        layer_item.children[0].textContent = stateVisible == "true" ? "⚪" : "⭕"
        if (stateVisible == "false") {
            layer_item.children[1].style.display = 'none';
            layer_item.style.background = "#8f4b04";
        } else {
            switch (parseInt(state)) {

                case this.STATE.Selected:
                    layer_item.children[1].style.display = 'flex';
                    layer_item.style.background = "red";
                    break;
                case this.STATE.MaskMode:
                    layer_item.style.background = "#4f407d";
                    break;
                case this.STATE.FreeDraw:
                    layer_item.style.background = "#005a4a";
                    break;

                default:
                    layer_item.style.background = index % 2 ? "var(--comfy-menu-bg)" : "var(--comfy-input-bg)";
                    break;


            }
        }

    }

    makeRootFolder(folder_parent_container) {
        const f = $el("div.folder_parent", { parent: folder_parent_container }, [
            $el("img.folder_icon", { src: `${ROOTDIR}` + "/asset/folder_icon.png" }),
            $el("div.folder_name", { textContent: "root" })]);
        this.imageslib_container.prepend(folder_parent_container);
        f.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.fetchImages();
        })
    }

    calcWH(ow, oh, nw = null, nh = null) {
        if ((nw && !nh) || (!nw && nh)) {
            if (nw) {
                const ratio = nw / ow;
                return {
                    width: (nw / ow),
                    height: (oh * ratio / oh)
                };
            } else if (nh) {
                const ratio = nh / oh;
                return {
                    width: (ow * ratio / ow),
                    height: (nh / oh)
                };
            }
        } else {
            console.error('Please provide either desiredWidth or desiredHeight, not both or neither.');
            return null;
        }
    }

    updateLayerData(id, img, l, tr) {


        id.layer.dataset.positionX = l.x();
        id.layer.dataset.positionY = l.y();
        id.layer.dataset.scaleX = img.scaleX();
        id.layer.dataset.scaleY = img.scaleY();
        id.layer.dataset.rotation = tr.rotation();

    }

    showImageDialog(e) {
        if (!this.imageslib_container) return;
        this.imageslib_container.classList.add("dialogshow")

    }
    deselectAll() {
        this.icomp_stage
            .getChildren()
            .filter((e) => e.getClassName() === "Layer")
            .map((x) => {
                x.draggable(false);
                x.listening(false);
                const tr = x
                    .getChildren()
                    .filter((cl) => cl.getClassName() === "Transformer")[0];
                if (tr != null) tr.nodes([]);
            });

        this.icomp_layers_container.querySelectorAll(".layer_item:nth-child(2n+1)").forEach((e) => {
            e.style.background = "var(--comfy-input-bg)";
        });
        this.icomp_layers_container.querySelectorAll(".layer_item_mask").forEach((e) => {
            e.style.display = "none";
        });
        this.icomp_layers_container.querySelectorAll(".layer_item:nth-child(2n+2)").forEach((e) => {
            e.style.background = "var(--comfy-menu-bg)";
        });
        this.icomp_layers_container.querySelectorAll(".layer_item").forEach((e) => {
            e.dataset.layerState = this.STATE.Normal;
        });


        this.brushLayer.hide();

    }

    updateLayers() {
        this.icomp_layers_container.querySelectorAll(".layer_item").forEach((e, index) => {
            this.UpdateLayerState(e, index)
        });
    }
    layerItemsToData(canvas, content, image) {
        canvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const _tempimg = document.createElement("img");
            _tempimg.onload = () => {
                URL.revokeObjectURL(url)
            };

            const result = {
                position: { x: image.x(), y: image.y() },
                scale: { x: image.scaleX(), y: image.scaleY() },
                id: content.id,
                name: content.name,
                index: content.index,
                layerStateVisible: content.layerStateVisible,
                freedraw: content.freedraw,
                blob: blobToBase64(url)
            };


        }, "image/png")
    }

    async canvasToBase64(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(async (blob) => {
                resolve(await blobToBase64(blob))
            }, "image/png")
        })

    }
    loadConfig() {
        api.fetchApi("/composer/loadconfig?config_name=" + this.config_file)
            .then((response) => response.json())
            .then((result) => {
                if (!result.success) return;
                const data = result.data.sort((a, b) => a.index - b.index);
                for (const d of data) {
                    this.addLayer(d.name, d, d.freedraw);
                }

            })
    }
    saveConfigFile(json_data) {
        const f = new FormData();
        f.append("config_json", json_data);
        f.append("config_name", this.config_file);
        api.fetchApi("/composer/saveconfig", {
            method: "POST",
            body: f
        }).then((response) => { if (response.ok) return response.json() })
            .then((result) => {

            })
    }
    async saveKonvaCanvasInfo() {
        const json_data = []
        for (const ld of this.layersData) {
            let position, scale, rotation;
            if (ld.image == null) {
                position = { x: 0, y: 0 };
                scale = { x: 1, y: 1 }
                rotation = 0;

            } else {
                const l = ld.layer.dataset;
                position = { x: parseInt(l.positionX), y: parseInt(l.positionY) };
                scale = { x: ld.image.scaleX(), y: ld.image.scaleY() };
                rotation = parseInt(l.rotation);
            }
            const layer = {
                id: ld.id,
                name: ld.layer.dataset.name,
                index: parseInt(ld.layer.dataset.index),
                layerStateVisible: ld.layer.dataset.layerStateVisible === 'true',
                freedraw: ld.layer.dataset.freedraw === 'true',
                position: position,
                scale: scale,
                inverted_mask: ld.layer.dataset.invertedMask === 'true',
                rotation: rotation,
                maskBase64Image: ld.canvas == undefined ? null : await this.canvasToBase64(ld.canvas)
            }
            json_data.push(layer);
        }
        this.saveConfigFile(JSON.stringify(json_data));




    }
    konvaStageEvent() {
        var self = this
        let scale = 5;
        this.icomp_stage.on("wheel", (e) => {

            scale += e.evt.deltaY * 0.05;
            scale = Math.min(Math.max(5, scale), 100);

            self.currentMaskContext.lineWidth = scale * 2;
            self.brushSize = scale * 2;
            self.brushCircle.radius(self.brushSize / 2);
        });
        this.icomp_stage.on("mousemove", function (e) {

            if (self.currentMaskLayer == null || !self.maskMode) return;
            if (!self.brushCircle.isVisible()) self.brushCircle.show();

            self.currentMaskContext.lineWidth = (self.brushSize) / self.layerScale.x;

            var pos = self.currentMaskLayer.getRelativePointerPosition();
            var mousepose = self.icomp_stage.getRelativePointerPosition();
            self.brushCircle.x(mousepose.x);
            self.brushCircle.y(mousepose.y);

            if (
                !self.isPaint ||
                !self.currentMaskImg ||
                !self.currentMaskLayer ||
                !self.lastPointerPosition ||
                !self.currentMaskContext
            )
                return;
            self.currentMaskContext.globalCompositeOperation = !e.evt.shiftKey
                ? "source-over"
                : "destination-out";
            self.currentMaskContext.beginPath();
            var localPos = {
                x:
                    self.lastPointerPosition.x / self.currentMaskImg.scaleX() -
                    self.currentMaskImg.x() / self.currentMaskImg.scaleX(),
                y:
                    self.lastPointerPosition.y / self.currentMaskImg.scaleY() -
                    self.currentMaskImg.y() / self.currentMaskImg.scaleY(),
            };
            self.currentMaskContext.moveTo(localPos.x, localPos.y);

            var nlocalPos = {
                x:
                    pos.x / self.currentMaskImg.scaleX() -
                    self.currentMaskImg.x() / self.currentMaskImg.scaleX(),
                y:
                    pos.y / self.currentMaskImg.scaleY() -
                    self.currentMaskImg.y() / self.currentMaskImg.scaleY(),
            };

            self.currentMaskContext.lineTo(nlocalPos.x, nlocalPos.y);
            self.currentMaskContext.closePath();
            self.currentMaskContext.stroke();

            self.lastPointerPosition = pos;
            self.currentMaskLayer.batchDraw();
            self.stageEventNotifier = true;

        });

    }



}

async function ComposerWidget(node, inputName, inputData, app) {
    const widget = {
        type: "composer_canvas",
        name: `widget_${inputName}`,

        draw: function (ctx, _, widgetWidth, widgetY, _widgetHeight) {
            let y
            if (!node.canvasHeight) {
                y = computeCanvasSize(node, node.size)
            }
            const visible = true //app.canvasblank.ds.scale > 0.5 && this.type === "customCanvas";
            const t = ctx.getTransform();
            const margin = 10
            const border = 2

            const widgetHeight = node.canvasHeight
            const values = node.properties["values"]
            const width = Math.round(node.properties["width"])
            const height = Math.round(node.properties["height"])
            this.wrapper.icomp_stage.width(width);
            this.wrapper.icomp_stage.height(height);
            this.wrapper.canvaswidth = width;
            this.wrapper.cnvs_height = height;
            const scale = Math.min((widgetWidth - margin * 2) / width, (widgetHeight - margin * 2) / height)




            //this.canvas.hidden = !visible;

            let backgroudWidth = width * scale
            let backgroundHeight = height * scale

            let xOffset = margin
            if (backgroudWidth < widgetWidth) {
                xOffset += (widgetWidth - backgroudWidth) / 2 - margin
            }
            let yOffset = margin
            if (backgroundHeight < widgetHeight) {
                yOffset += (widgetHeight - backgroundHeight) / 2 - margin
            }


            let widgetX = xOffset
            widgetY = widgetY + yOffset

            const cnvs_width = (width * t.a);
            const cnvs_height = (height * t.d);
            const cnvs_left = t.e + ((widgetWidth * t.d - (cnvs_width * scale)) / 2);
            Object.assign(this.wrapper.canvas.style, {
                left: `${cnvs_left}px`,
                top: `${t.f + (widgetY * t.d) + margin}px`,
                position: "absolute",

                zIndex: 1,
                fontSize: `${t.d * 10.0}px`,
                transform: `scale(${scale * t.d, scale * t.d})`,
                transformOrigin: `top left`,
            });



            Object.assign(this.wrapper.icomp_menu_container.style, {
                left: `${cnvs_left}px`,
                top: `${t.f + (widgetY * t.d) + margin}px`,
                position: "absolute",
                display: this.wrapper.show_menu ? "flex" : "none",
                flexDirection: "column",
                zIndex: 1,
                fontSize: `${t.d * 14.0}px`,
            });

            Object.assign(this.wrapper.statusbar.style, {
                left: `${t.e}px`,
                top: `${t.f + (widgetY * t.d) - (margin * t.d)}px`,// `${t.f + ((node.size[1] - 20) * t.d)}px`,
                width: `${node.size[0] * t.d}px`,
                fontSize: `${t.d * 10.0}px`,
                padding: `${t.d * 0.0}px ${t.d * 0}px`,
                borderRadius: `${t.d * 0.0}px`,


            })


            this.wrapper.scaleWidget(t.d);

            document.querySelectorAll(".layer_item").forEach(l => {
                l.style.padding = `${2 * t.d}px ${10 * t.d}px`;
            });
            Object.assign(this.wrapper.colorpicker.style, {
                width: `${20 * t.d}px`,
                height: `${20 * t.d}px`,
            })



            this.wrapper.canvasPosition = {
                left: cnvs_left,
                top: t.f + (widgetY * t.d) + margin,
                scale: t.d,
                w: cnvs_width,
                h: cnvs_height
            }

            Object.assign(this.wrapper.icomp_layers_container?.style, {
                left: `${t.e + widgetWidth * t.d}px`,
                top: `${t.f + (LiteGraph.NODE_SLOT_HEIGHT * 7) * t.d}px`,
                position: "absolute",
                display: this.wrapper.show_menu ? "flex" : "none",
                width: `${200 * t.d}px`,
                zIndex: 1,
                fontSize: `${t.d * 0.7}rem`,


            });
        },
    }
    node.composer = new IMComposer(node, widget.canvas, `icomp_container_${inputName.toLowerCase()}`);
    window.ImageComposer = node.composer;
    widget.parent = node;
    node.composer.addElements();
    widget.wrapper = node.composer;
    node.addCustomWidget(widget);
    await node.composer.loadImages();





    node.onResize = function (size) {
        computeCanvasSize(node, size);
    }

    node.onRemoved = () => {
        node.composer.Delete();
    }
    widget.onRemove = () => {
        widget.wrapper.remove();
    }


    return { widget }
}

function addLibraries() {
    $el("link", {
        parent: document.head,
        rel: "stylesheet",
        type: "text/css",
        href: new URL(`${ROOTDIR}/css/imagecomposer.css`, import.meta.url)
    });
    $el("script", {
        parent: document.head,
        href: new URL(`${ROOTDIR}/lib/Sortable.min.js`, import.meta.url)
    });
    $el("script", {
        parent: document.head,
        href: new URL(`./lib/konva.js`, import.meta.url)
    });


}

const ext = {
    name: "jmkl.imagecomposer",
    async init() {
        addLibraries();
    },
    async setup(app) {


    },


    nodeCreated(node) {
        if (node.widgets) {
            const widget = node.widgets.filter((n) => n.name === "image")[0];
            widget.computeSize = () => [0, -4];


        }
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {

        if (nodeData.name === "Image Composer") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {

                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

                let INode = app.graph._nodes.filter(no => no.type === "Image Composer");

                let nodeName = `IComp_${INode.length + 1}`;
                ComposerWidget.apply(this, [this, nodeName, {}, app])
                this.setSize([530, 570]);
                return r;
            }

            const onDrawBackground = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function () {
                const r = onDrawBackground ? onDrawBackground.apply(this, arguments) : undefined;

                Object.assign(this.composer.icomp_menu_container.style, {
                    display: this.flags.collapsed ? "none" : "flex",
                });
                Object.assign(this.composer.icomp_stage_container.style, {
                    display: this.flags.collapsed ? "none" : "flex",
                });
                Object.assign(this.composer.icomp_layers_container.style, {
                    display: this.flags.collapsed ? "none" : "flex",
                });

                return r;
            }


        }
    }
}

app.registerExtension(ext);