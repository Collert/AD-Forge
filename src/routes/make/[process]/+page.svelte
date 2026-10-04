<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ModelViewer from '$lib/components/ModelViewer.svelte';
	import HelpButton from '$lib/components/HelpButton.svelte';
	import HelpDialog from '$lib/components/HelpDialog.svelte';
	import type { HelpKey } from '$lib/catalog/help';
	import type { ModelInfo } from '$lib/viewer/analysis';
	import { formatOf, isStoredModel, nameOf, type ModelSource, type StoredModel } from '$lib/viewer/load-model';
	import type { RepairReport } from '$lib/viewer/repair';
	import { areaThinnerThan, thinnestWall } from '$lib/viewer/thickness';
	import { planSetups, pocketStats, type SetupPlan } from '$lib/viewer/machining';
	import {
		createPart,
		createPartSaver,
		deletePart,
		getMesh,
		getPart,
		getSource,
		keepsSource,
		replaceMesh,
		type PartConfig,
		type MachiningConfig,
		type PartRecord,
		type ResinConfig,
		type SpecChip
	} from '$lib/storage/parts';
	import type { OrientationFit } from '$lib/viewer/orient';
	import { identityTransform, type ModelTransform } from '$lib/viewer/transform';
	import { pendingUpload } from '$lib/upload.svelte';
	import {
		axisModes,
		compensationRange,
		defaultProfile,
		defaults,
		fineDetailMinArea,
		fineDetailProcessId,
		largeMeshTriangles,
		finestCornerTool,
		machiningDefaults,
		machiningProfile,
		machiningRates,
		pocketCutters,
		fuzzySkinModes,
		infillPatterns,
		infillPresets,
		infillRange,
		nozzles,
		overhangRange,
		priceTiers,
		processes,
		processProfiles,
		qualities,
		resinDefaults,
		resinProfile,
		resinQualities,
		shellCountRange,
		shellStrategies,
		supportPlacements,
		wallLoopOptions,
		wallSequences,
		type AxisMode,
		type ChoiceOption,
		type ColorOption,
		type Material,
		type Resin,
		type StockGroup,
		type NumberRange
	} from '$lib/catalog/config';
	import {
		estimateMachining,
		estimatePrint,
		estimateResin,
		resinPartMl,
		type MachiningSettings,
		type PrintCost,
		type PrintSettings,
		type ResinSettings,
		type ResolvedOptions
	} from '$lib/pricing/estimate';
	import { lowestUnitPrice, tierAmountOff, tierUnitPrice } from '$lib/pricing/tiers';
	import { finalizeDesign, isOrderable, requestQuote, RequestError, type FinalizedDesign, type Quote } from '$lib/pricing/quote';
	import { addToCart, cart, cartQuantity, markNewDesign } from '$lib/cart.svelte';

	let { data } = $props();

	/** Materials, resins and stock from the store. */
	let catalog = $derived(data.catalog);

	// ---------- Selection state ----------

	// Raw: a stored mesh can be megabytes of typed arrays — never deep-proxy it.
	let source = $state.raw<ModelSource | null>(pendingUpload.file);
	pendingUpload.file = null;

	let info = $state<ModelInfo | null>(null);
	let transform = $state<ModelTransform>(identityTransform());
	let orientationFit = $state<OrientationFit>(null);
	let processId = $derived(data.processId);
	let mode = $state<'simple' | 'advanced'>('simple');
	let categoryId = $state(untrack(() => data.catalog.defaults.categoryId));
	let materialId = $state(untrack(() => data.catalog.defaults.materialId));
	/** Shopify variant id of the color; empty picks the first one in stock. */
	let colorId = $state('');
	let qualityId = $state(defaults.qualityId);
	let partName = $state('');

	/** FDM slicer settings shared by the Simple and Advanced tabs (layer height comes from `qualityId`). */
	const recommendedFdm = (): Omit<PrintSettings, 'layerHeight'> => ({
		nozzle: defaults.nozzle,
		wallLoops: defaults.wallLoops,
		topShells: defaults.topShells,
		bottomShells: defaults.bottomShells,
		wallSequence: defaults.wallSequence,
		detectThinWalls: defaults.detectThinWalls,
		infill: defaults.infill,
		infillPattern: defaults.infillPattern,
		supportPlacement: defaults.supportPlacement,
		overhangAngle: defaults.overhangAngle,
		supportInterface: defaults.supportInterface,
		xyHoleCompensation: defaults.xyHoleCompensation,
		xyContourCompensation: defaults.xyContourCompensation,
		ironing: defaults.ironing,
		fuzzySkin: defaults.fuzzySkin
	});
	let fdm = $state(recommendedFdm());

	/** SLA selections. */
	let resinConfig = $state<ResinConfig>({ ...resinDefaults, resinId: untrack(() => data.catalog.defaults.resinId) });

	/** CNC selections. */
	let machiningConfig = $state<MachiningConfig>({ ...machiningDefaults, materialId: untrack(() => data.catalog.defaults.stockId) });

	const byId = <T extends { id: string }>(items: T[], id: string) => items.find((i) => i.id === id) ?? items[0];
	/** The chosen color variant, else the first in stock, else the first. */
	const pickColor = (items: ColorOption[], id: string | undefined) =>
		items.find((c) => c.id === id) ?? items.find((c) => c.inStock) ?? items[0];

	let process = $derived(processes.find((p) => p.id === processId)!);
	let profile = $derived(processProfiles[processId] ?? defaultProfile);
	/** Filament categories this process can print: open-frame printers skip filaments that need an enclosure. */
	let materialCategories = $derived(
		catalog.materialCategories
			.map((c) => ({ ...c, materials: c.materials.filter((m) => process.enclosed || !m.requiresEnclosure) }))
			.filter((c) => c.materials.length > 0)
	);
	let category = $derived(byId(materialCategories, categoryId));
	let baseMaterial = $derived(byId(category.materials, materialId));
	let color = $derived(pickColor(baseMaterial.colors, colorId));
	/** The filament as priced and stocked in the chosen color. */
	let material = $derived<Material>({ ...baseMaterial, pricePerGram: color.price, inStock: color.inStock });
	let colorHex = $derived(color.hex);
	let quality = $derived(qualities.find((q) => q.id === qualityId)!);
	/** Nozzle sizes the chosen filament is approved for. */
	let allowedNozzles = $derived(material.nozzles ?? nozzles.map((n) => n.size));

	// A filament that can't use the current nozzle moves it to the nearest size it can (0.4 on a tie).
	$effect(() => {
		const allowed = allowedNozzles;
		const current = untrack(() => fdm.nozzle);
		if (allowed.includes(current)) return;
		const nearest = (n: number) => Math.abs(n - current) + Math.abs(n - defaults.nozzle) / 100;
		fdm.nozzle = [...allowed].sort((a, b) => nearest(a) - nearest(b))[0];
	});
	let settings = $derived<PrintSettings>({ ...fdm, layerHeight: quality.layerHeight });

	let options = $derived<ResolvedOptions>({
		material,
		infillPattern: byId(infillPatterns, fdm.infillPattern),
		supportPlacement: byId(supportPlacements, fdm.supportPlacement),
		supportInterface: byId(catalog.supportInterfaces, fdm.supportInterface),
		fuzzySkin: byId(fuzzySkinModes, fdm.fuzzySkin)
	});

	let isResin = $derived(process.kind === 'resin');
	let baseResin = $derived(byId(catalog.resins, resinConfig.resinId));
	let pigment = $derived(pickColor(baseResin.pigments, resinConfig.pigmentId));
	/** The resin as priced and stocked in the chosen pigment. */
	let resin = $derived<Resin>({ ...baseResin, pricePerMl: pigment.price, inStock: pigment.inStock });
	let resinQuality = $derived(byId(resinQualities, resinConfig.qualityId));
	let shell = $derived(byId(shellStrategies, resinConfig.shellId));
	let resinSettings = $derived<ResinSettings>({ layerHeight: resinQuality.layerHeight, hollow: shell.hollow });

	let isCnc = $derived(process.kind === 'machining');
	let stock = $derived(byId(catalog.stockMaterials, machiningConfig.materialId));
	let axisMode = $derived(byId(axisModes, machiningConfig.axes));
	let machiningSettings = $derived<MachiningSettings>({ axes: axisMode.id });
	/** Cheapest standard size of the stock usable with the current axis mode (pieces for 3-axis, bars for 4-axis). */
	let stockFromPrice = $derived.by(() => {
		const sizes = axisMode.id === 'four' ? stock.bars : stock.pieces;
		return Math.min(...(sizes.length ? sizes : [...stock.pieces, ...stock.bars]).map((s) => s.price));
	});
	let onRotary = $derived(isCnc && axisMode.id === 'four');
	const { rotary } = machiningProfile;

	/** The 4th axis holds a round bar along X; everything else uses the process envelope. */
	let machineBed = $derived(onRotary ? { x: rotary.length, y: rotary.diameter, z: rotary.diameter } : process.bed);
	let bedLabel = $derived(
		onRotary ? `Rotary: Ø${rotary.diameter} × ${rotary.length}mm` : `${process.bedLabel}: ${process.bed.x}×${process.bed.y}mm`
	);
	/** Bed fit, plus the exact round-bar check once tool access has measured the part's radius. */
	let fitsMachine = $derived(
		!!info && info.fitsBed && !(onRotary && info.machining && info.machining.rotaryRadius * 2 > rotary.diameter)
	);
	/** Fewest setups for each axis mode, once tool access is measured. */
	let setupPlans = $derived.by(() => {
		const m = info?.machining;
		if (!m) return null;
		const { hiddenMinArea: min, hiddenMinShare: share } = machiningProfile;
		return { three: planSetups(m, 'three', min, share), four: planSetups(m, 'four', min, share) };
	});
	/** 4-axis when it reaches surfaces 3-axis can't from any side, or saves at least two flips. */
	let recommendedAxes = $derived.by((): AxisMode['id'] | null => {
		if (!setupPlans) return null;
		const { three, four } = setupPlans;
		if (four.hidden >= four.threshold) return 'three';
		return three.hidden >= three.threshold || three.setups - four.setups >= 2 ? 'four' : 'three';
	});

	function selectStockGroup(group: StockGroup) {
		if (stock.group === group) return;
		machiningConfig = { ...machiningConfig, materialId: catalog.stockMaterials.find((m) => m.group === group)!.id };
	}

	function setAxes(id: AxisMode['id']) {
		machiningConfig = { ...machiningConfig, axes: id };
	}

	/** What the active process prints with, for the preview and summaries. */
	let layerHeight = $derived(isResin ? resinQuality.layerHeight : isCnc ? 1 : quality.layerHeight);
	/** Share of resin hollowing saves versus printing solid. */
	let hollowSaving = $derived(info && info.volume > 0 ? 1 - resinPartMl(info, true, resinProfile) / info.volume : 0);
	let partColor = $derived(isResin ? pigment.hex : isCnc ? stock.color : colorHex);
	let overhangAngle = $derived(isResin ? resinProfile.overhangAngle : fdm.overhangAngle);

	/** Switch resin, keeping a pigment of the same name if the new one has it. */
	function selectResin(id: string) {
		const next = byId(catalog.resins, id);
		resinConfig = { ...resinConfig, resinId: next.id, pigmentId: next.pigments.find((p) => p.name === pigment.name)?.id };
	}

	// A newly loaded model starts with its file name as the part name (a reopened part keeps its saved name).
	let lastModelName: string | null = null;
	$effect(() => {
		const name = info?.name;
		// `info` is a new object after every rotate/scale — only react to a different model.
		if (!name || name === lastModelName) return;
		lastModelName = name;
		untrack(() => {
			partName = pendingName ?? baseName(name);
			pendingName = null;
		});
	});

	// A different model is on its way in: hold autosave until it has loaded.
	$effect(() => {
		void source;
		untrack(() => {
			partReady = false;
			repaired = null;
			repairError = '';
		});
	});

	// ---------- Pricing: instant estimate → accurate quote ----------

	let estimate = $derived(
		!info
			? null
			: isResin
				? estimateResin(info, resinSettings, resin, resinProfile)
				: isCnc
					? estimateMachining(info, axisMode, stock, machiningProfile, machiningRates)
					: estimatePrint(info, settings, options, profile)
	);

	/** Everything that affects the price; a quote is only valid for the key it was made with. */
	let configKey = $derived(
		info
			? JSON.stringify([
					info.name,
					info.triangles,
					transform,
					processId,
					...(isResin
						? [resin.id, pigment.id, resinSettings]
						: isCnc
							? [stock.id, machiningSettings]
							: [material.id, color.id, settings])
				])
			: ''
	);

	let quote = $state.raw<{ key: string; result: Quote } | null>(null);
	let quoting = $state(false);
	let quoteError = $state('');

	let quoteCurrent = $derived(quote !== null && quote.key === configKey);
	let quoteStale = $derived(quote !== null && !quoteCurrent);
	let pricing = $derived(quoteCurrent ? quote!.result : estimate);
	/** The original STEP upload, which CNC parts are machined from (kept with the part in browser storage). */
	let stepFile = $state.raw<File | null>(null);
	// A new upload brings its own STEP file (or none); a reopened part gets its stored one in `restore`.
	$effect(() => {
		const next = source;
		untrack(() => {
			if (next instanceof File) stepFile = keepsSource(formatOf(next)) ? next : null;
			else if (!isStoredModel(next)) stepFile = null;
		});
	});
	let scaled = $derived(transform.scale.x !== 1 || transform.scale.y !== 1 || transform.scale.z !== 1);
	/** Why this CNC part can't be quoted yet, if it can't. */
	let cncBlocker = $derived(
		!isCnc || !info
			? null
			: !stepFile
				? 'CNC machining needs the part’s STEP (.step / .stp) file. Upload it to get a quote.'
				: scaled
					? 'CNC parts are machined from your STEP file at its designed size. Reset the scale to 100% to get a quote.'
					: null
	);
	let canQuote = $derived(!!source && !!info && fitsMachine && !quoting && !cncBlocker);

	async function getQuote() {
		if (!source || !estimate) return;
		const key = configKey;
		quoting = true;
		quoteError = '';
		try {
			// The edited part as the viewer shows it (repaired, rotated, scaled), resting on the bed.
			const model = await viewerRef?.exportModel();
			if (!model) throw new Error('The model is still loading. Try again in a moment.');
			const result = await requestQuote(
				{
					name: partName.trim() || baseName(info!.name),
					model,
					processId,
					processKind: process.kind,
					materialId: isResin ? resin.id : isCnc ? stock.id : material.id,
					colorId: isResin ? pigment.id : isCnc ? stock.id : color.id,
					settings: isResin ? resinSettings : isCnc ? machiningSettings : settings,
					source: isCnc ? stepFile : null,
					transform: $state.snapshot(transform)
				},
				estimate
			);
			quote = { key, result };
		} catch (err) {
			quoteError = (err as Error).message || 'Could not get a quote. Please try again.';
		} finally {
			quoting = false;
		}
	}

	// ---------- Floating "Get Quote" shortcut ----------

	/** The price card, watched so the shortcut hides while it's on screen. */
	let quoteCard = $state<HTMLElement>();
	let quoteCardVisible = $state(true);
	$effect(() => {
		const card = quoteCard;
		if (!card) return;
		const observer = new IntersectionObserver(([entry]) => (quoteCardVisible = entry.isIntersecting));
		observer.observe(card);
		return () => observer.disconnect();
	});
	/** Your own part, still without a current accurate quote, and the price card scrolled away. */
	let showQuoteShortcut = $derived(!!source && !!info && !quoteCurrent && !quoteCardVisible);
	/** The cart bar is showing at the bottom, so the shortcut sits just above it. */
	let cartBarShown = $derived(cartQuantity() > 0 && !cart.open);

	function scrollToQuote() {
		quoteCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	/** The phone-sized method dropdown at the top of the page. */
	let methodSelect = $state<HTMLSelectElement>();

	/** Scroll back up to the method dropdown and open it (where the browser allows opening it from script). */
	function openMethodPicker() {
		const select = methodSelect;
		if (!select) return;
		select.scrollIntoView({ behavior: 'smooth', block: 'start' });
		try {
			select.showPicker();
		} catch {
			select.focus({ preventScroll: true });
		}
	}

	/** Same as tapping a method tile: keep the open part. */
	function switchProcess(id: string) {
		if (id !== processId) goto(`/make/${id}${partId ? `?part=${partId}` : ''}`, { noScroll: true, keepFocus: true });
	}

	/** Query flag on the sign-in return URL: confirm the restored quote automatically. */
	const CONFIRM_PARAM = 'confirm';

	/** Design created from a quote (by quote id), so confirming twice reuses it. */
	let finalized = $state.raw<{ quoteId: string; design: FinalizedDesign } | null>(null);
	let finalizing = $state(false);
	let finalizeError = $state('');
	let needsSignIn = $state(false);
	let finalizedCurrent = $derived(quoteCurrent && finalized?.quoteId === quote!.result.id);
	/** Signed in (or a guest the server accepts); otherwise Confirm signs in first. */
	let canSave = $derived(data.canSave && !needsSignIn);
	/** Quotes for this process can be ordered online. */
	let orderable = $derived(isOrderable(process.kind));

	/** Back to this part after signing in, with `confirm` set so the upload finishes by itself. */
	let signInHref = $derived.by(() => {
		const back = new URL(page.url);
		if (partId) back.searchParams.set('part', partId);
		back.searchParams.set(CONFIRM_PARAM, '1');
		return `/account/login?returnTo=${encodeURIComponent(back.pathname + back.search)}`;
	});

	/** Save the part and its quote to this browser, then go sign in. */
	async function signInToConfirm(event: MouseEvent) {
		event.preventDefault();
		await saver.flush();
		location.href = signInHref;
	}

	// Back from signing in: once the part and its quote are restored, finish the upload once.
	let autoConfirm = $state(untrack(() => page.url.searchParams.has(CONFIRM_PARAM)));
	$effect(() => {
		if (!autoConfirm || restoring || !partReady || !info) return;
		autoConfirm = false;
		untrack(() => {
			const url = new URL(page.url);
			url.searchParams.delete(CONFIRM_PARAM);
			goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true });
			if (quoteCurrent) confirmUpload();
			else if (quote) finalizeError = 'Your settings changed since the quote. Get an updated quote, then confirm.';
		});
	});

	/**
	 * Save the quoted part as a design (its file and a store product), put it in
	 * the cart, then show it under My Designs with the cart open. The draft leaves
	 * the Shelf, since the finalized design replaces it.
	 */
	async function confirmUpload() {
		if (!quoteCurrent || finalizing || !orderable) return;
		const quoteId = quote!.result.id;
		finalizing = true;
		finalizeError = '';
		needsSignIn = false;
		try {
			const design =
				finalized?.quoteId === quoteId
					? finalized.design
					: await finalizeDesign(quoteId, partName.trim() || baseName(info!.name), (await viewerRef?.thumbnail()) ?? null);
			finalized = { quoteId, design };
			markNewDesign(design.variantId);
			await addWhenListed(design.variantId);
			if (partId) await deletePart(partId).catch((err) => console.error('Could not remove the finalized draft', err));
			await goto('/library');
			cart.open = true;
		} catch (err) {
			needsSignIn = err instanceof RequestError && err.status === 401;
			finalizeError = (err as Error).message || "Couldn't save your design. Please try again.";
		} finally {
			finalizing = false;
		}
	}

	/** A new product takes a few seconds to reach the storefront; retry the add until it does. */
	async function addWhenListed(variantId: string) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await addToCart(variantId);
			} catch (err) {
				if (attempt >= 4) throw err;
				await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
			}
		}
	}

	// ---------- Mesh repair ----------

	/** Result of the last auto-repair; `source` is the repaired mesh to quote instead of the upload. */
	let repaired = $state.raw<{ report: RepairReport; source: StoredModel | null } | null>(null);
	let repairing = $state(false);
	let repairError = $state('');

	async function repairModel() {
		if (!viewerRef || repairing) return;
		const id = partId;
		const original = source;
		repairing = true;
		repairError = '';
		// Let the button's busy state paint before the synchronous repair runs.
		await new Promise((r) => setTimeout(r, 30));
		try {
			const result = await viewerRef.repair();
			if (!result || source !== original) return;
			repaired = {
				report: result.report,
				source: original
					? { kind: 'stored', name: nameOf(original), mesh: result.mesh }
					: null
			};
			if (id) await replaceMesh(id, result.mesh);
		} catch (err) {
			console.error('Mesh repair failed', err);
			repairError = 'Auto-repair failed. Re-export the model from your CAD tool and upload it again.';
		} finally {
			repairing = false;
		}
	}

	// ---------- Printability checks ----------

	type Check = {
		tone: 'ok' | 'info' | 'warn' | 'error';
		icon: string;
		title: string;
		badge: string;
		detail: string;
		action?: { icon: string; label: string; href?: string; onclick?: () => void };
		/** A heads-up that doesn't affect printability, so it isn't counted as an issue. */
		advisory?: boolean;
	};

	let checks = $derived.by((): Check[] => {
		if (!info || !estimate) return [];
		const list: Check[] = [];

		if (isCnc && source && !stepFile) {
			list.push({
				tone: 'error',
				icon: 'description',
				title: 'STEP File Required',
				badge: 'Can’t Order',
				detail: keepsSource(formatOf(source))
					? 'This part was saved before CNC ordering, so its original STEP file wasn’t kept with it. Upload the STEP file again to get a quote.'
					: `CNC machines are programmed from your CAD model, so ordering needs a STEP (.step / .stp) file. ${formatOf(source).toUpperCase()} files only carry a triangle mesh, so the estimate is a guide. Export a STEP file from your CAD software and upload it.`
			});
		} else if (isCnc && scaled) {
			list.push({
				tone: 'error',
				icon: 'aspect_ratio',
				title: 'Scaled Part',
				badge: 'Can’t Order',
				detail: 'CNC parts are machined straight from your STEP file, at the size it was designed. Reset the scale to 100%, or change the size in your CAD software and upload it again. Rotating is fine.',
				action: { icon: 'restart_alt', label: 'Reset Scale', onclick: () => (transform = { ...transform, scale: { x: 1, y: 1, z: 1 } }) }
			});
		}

		if (orientationFit === 'impossible') {
			list.push({
				tone: 'error',
				icon: 'error',
				title: 'No Orientation Fits Build Volume',
				badge: 'Cannot Print',
				detail: `We tried every rotation and the part can't fit the ${process.bed.x} × ${process.bed.y} × ${process.bed.z} mm ${process.title} envelope at its current scale. Scale it down, split it, or pick a larger process.`
			});
		} else if (onRotary && !fitsMachine && info.machining) {
			list.push({
				tone: 'error',
				icon: 'error',
				title: 'Too Large for the Rotary',
				badge: 'Needs Review',
				detail: `The part needs a ${mm(info.machining.rotaryRadius * 2)} mm diameter × ${mm(info.size.x)} mm bar; the 4th axis takes up to Ø${rotary.diameter} × ${rotary.length} mm. Rotate it so its long side runs along X, scale it down, or use 3-axis.`
			});
		} else if (!fitsMachine) {
			list.push({
				tone: 'error',
				icon: 'error',
				title: 'Build Envelope Exceeded',
				badge: 'Needs Review',
				detail: `Part is ${mm(info.size.x)} × ${mm(info.size.y)} × ${mm(info.size.z)} mm; the ${process.title} envelope is ${process.bed.x} × ${process.bed.y} × ${process.bed.z} mm. Use “Try to Fit Build Plate” in the rotate tool, scale it down, or pick a larger process.`
			});
		}

		if (info.openEdges > 0) {
			list.push({
				tone: 'warn',
				icon: 'warning',
				title: 'Mesh Not Watertight',
				badge: repaired ? 'Partly Repaired' : 'Needs Repair',
				detail: repairError
					? repairError
					: repaired
						? `Auto-repair closed ${repaired.report.holesFilled.toLocaleString()} ${plural(repaired.report.holesFilled, 'hole')}, but ${info.openEdges.toLocaleString()} open edges remain (usually tangled or self-intersecting geometry). Re-export from CAD for a clean print.`
						: `${info.openEdges.toLocaleString()} open edges found. Holes in the mesh can confuse slicing — run auto-repair or re-export from CAD.`
			});
		}

		const angle = overhangAngle;
		if (isResin) {
			list.push(...resinChecks(info, estimate.supportGrams / resin.density));
		} else if (isCnc) {
			list.push(...machiningChecks(info));
		} else if (info.overhangArea <= 0.05) {
			list.push({
				tone: 'ok',
				icon: 'check_circle',
				title: 'Overhang Angle Check',
				badge: 'Passed',
				detail: `No surfaces exceed the ${angle}° overhang threshold. Prints without supports.`
			});
		} else if (options.supportPlacement.coverage === 0) {
			list.push({
				tone: 'warn',
				icon: 'warning',
				title: 'Unsupported Overhangs',
				badge: 'Supports Off',
				detail: `${info.overhangArea.toFixed(1)} cm² of surface exceeds the ${angle}° threshold but supports are turned off. Those areas may sag or fail.`
			});
		} else {
			list.push({
				tone: 'info',
				icon: 'info',
				title: 'Overhang Angle Check',
				badge: 'Auto-Supported',
				detail: `${info.overhangArea.toFixed(1)} cm² of surface exceeds the ${angle}° overhang threshold; supports will be generated (${options.supportPlacement.label.toLowerCase()}, ≈${estimate.supportGrams.toFixed(1)}g material added). Toggle the overhang view in the preview to see them.`
			});
		}

		if (info.openEdges === 0) {
			list.push({
				tone: 'ok',
				icon: 'check_circle',
				title: 'Watertight Manifold Topology',
				badge: 'Passed',
				detail: `0 open edges across ${info.triangles.toLocaleString()} triangles. Mesh geometry fully closed and volume watertight.`
			});
			if (repaired) {
				list.push({
					tone: 'info',
					icon: 'build',
					title: 'Mesh Auto-Repaired',
					badge: 'Repaired',
					detail: repairSummary(repaired.report)
				});
			}
		}

		list.push(wallThicknessCheck(info));

		if (info.triangles > largeMeshTriangles) {
			list.push({
				tone: 'warn',
				icon: 'warning',
				title: 'High Triangle Count',
				badge: 'Review Required',
				advisory: true,
				detail: `${info.triangles.toLocaleString()} triangles (over ${largeMeshTriangles.toLocaleString()}). The preview may feel sluggish and quotes can take a little longer. If you order this part, our team reviews it before its first print — you won't be charged until it passes that review.`
			});
		}

		return list;
	});

	/** Measured wall thickness against what the current process can resolve; nudges fine detail to SLA. */
	function wallThicknessCheck(model: ModelInfo): Check {
		const title = 'Wall Thickness';
		const walls = model.thickness;
		if (!walls) {
			return { tone: 'info', icon: 'hourglass_top', title, badge: 'Measuring…', detail: 'Measuring wall thickness across the surface…' };
		}
		const thinnest = thinnestWall(walls, fineDetailMinArea);
		if (thinnest === null) {
			return {
				tone: 'info',
				icon: 'straighten',
				title,
				badge: 'Tech Review',
				detail: "Couldn't measure wall thickness on this mesh (it may be open or inside-out). A technician will check it before printing."
			};
		}

		if (process.kind !== 'extrusion') {
			const limit = process.minFeature;
			if (!limit) {
				return { tone: 'ok', icon: 'straighten', title, badge: 'Tech Review', detail: `Thinnest wall ≈ ${mm2(thinnest)} mm. A technician verifies it for ${process.title} before your part is made.` };
			}
			const tooThin = areaThinnerThan(walls, limit);
			if (tooThin >= fineDetailMinArea) {
				return {
					tone: 'warn',
					icon: 'warning',
					title: `Features Below ${process.badge} Resolution`,
					badge: 'Thicken in CAD',
					detail: `${area(tooThin)} of the part is thinner than the ${limit} mm ${process.badge} minimum (thinnest ≈ ${mm2(thinnest)} mm). Those details may not form — thicken them in CAD.`
				};
			}
			return { tone: 'ok', icon: 'straighten', title, badge: 'Passed', detail: `Thinnest wall ≈ ${mm2(thinnest)} mm, above the ${limit} mm ${process.badge} minimum.` };
		}

		const line = fdm.nozzle * profile.lineWidthFactor;
		const nozzle = `${fdm.nozzle.toFixed(1)} mm nozzle`;
		const tooFine = areaThinnerThan(walls, line);
		if (tooFine >= fineDetailMinArea) {
			const sla = processes.find((p) => p.id === fineDetailProcessId)!;
			const slaLimit = sla.minFeature ?? 0;
			const finestNozzle = Math.min(...allowedNozzles);
			const nozzleTip =
				fdm.nozzle > finestNozzle && finestNozzle * profile.lineWidthFactor <= thinnest
					? ` To stay on FDM, the ${finestNozzle.toFixed(1)} mm fine-detail nozzle can print them (slower).`
					: '';
			const what = `${area(tooFine)} of the part is thinner than the ${mm2(line)} mm line a ${nozzle} extrudes (thinnest ≈ ${mm2(thinnest)} mm), so FDM will skip or blob those details.`;

			if (thinnest < slaLimit) {
				return {
					tone: 'warn',
					icon: 'warning',
					title: 'Features Too Thin to Print',
					badge: 'Thicken in CAD',
					detail: `${what} That's below even ${sla.badge}'s ${slaLimit} mm minimum — thicken them in CAD.`
				};
			}
			if (!fitsVolume(model.size, sla.bed)) {
				return {
					tone: 'warn',
					icon: 'zoom_in',
					title: 'Fine Details Too Small for FDM',
					badge: 'Detail Loss',
					detail: `${what} ${sla.title} would resolve them, but the part is larger than its ${sla.bed.x} × ${sla.bed.y} × ${sla.bed.z} mm vat.${nozzleTip}`
				};
			}
			return {
				tone: 'warn',
				icon: 'zoom_in',
				title: 'Fine Details Too Small for FDM',
				badge: `Try ${sla.badge}`,
				detail: `${what} ${sla.title} resolves features down to ${slaLimit} mm with a smoother finish.${nozzleTip}`,
				action: { icon: sla.icon, label: `Switch to ${sla.title}`, href: `/make/${sla.id}${partId ? `?part=${partId}` : ''}` }
			};
		}

		const thin = areaThinnerThan(walls, 2 * line);
		if (thin >= fineDetailMinArea) {
			const what = `${area(thin)} of the part is under two lines thick (< ${mm2(2 * line)} mm with a ${nozzle})`;
			return fdm.detectThinWalls
				? { tone: 'info', icon: 'straighten', title: 'Thin Walls', badge: 'Single Line', detail: `${what}. These print as single extrusions — weaker, but printable.` }
				: {
						tone: 'warn',
						icon: 'warning',
						title: 'Thin Walls',
						badge: 'May Be Skipped',
						detail: `${what}, and Detect Thin Walls is off, so the slicer may leave gaps there. Turn it on under Walls & Shells in Advanced.`
					};
		}

		return { tone: 'ok', icon: 'straighten', title, badge: 'Passed', detail: `Thinnest wall ≈ ${mm2(thinnest)} mm, comfortably above the ${mm2(line)} mm line width of a ${nozzle}.` };
	}

	/** Supports and hollowing — the SLA-only checks. */
	function resinChecks(model: ModelInfo, supportMl: number): Check[] {
		const list: Check[] = [];
		list.push(
			model.overhangArea <= 0.05
				? {
						tone: 'ok',
						icon: 'check_circle',
						title: 'Island & Overhang Supports',
						badge: 'Minimal',
						detail: `No surfaces exceed the ${overhangAngle}° threshold — supports are only needed under the base.`
					}
				: {
						tone: 'info',
						icon: 'info',
						title: 'Island & Overhang Supports',
						badge: 'Auto-Supported',
						detail: `${model.overhangArea.toFixed(1)} cm² of downward-facing surface gets light touch-point supports (≈${supportMl.toFixed(1)} ml resin). The tiny contact marks are sanded off after curing.`
					}
		);

		if (shell.hollow) {
			const hollows = resinPartMl(model, true, resinProfile) < model.volume;
			list.push(
				hollows
					? {
							tone: 'info',
							icon: 'water_drop',
							title: 'Drain & Vent Holes',
							badge: 'Added in Review',
							detail: `Hollow parts trap liquid resin and can create suction against the vat. A technician adds two Ø2.5 mm drain holes on a hidden face before printing — mention any face that must stay unbroken in your order notes.`
						}
					: {
							tone: 'ok',
							icon: 'check_circle',
							title: 'Shell Strategy',
							badge: 'Printed Solid',
							detail: `The part is too thin to hollow with ${resinProfile.hollowWall.toFixed(1)} mm walls, so it prints solid at the same price.`
						}
			);
		}
		return list;
	}

	/** Tool access, corners and pockets — the CNC-only checks. */
	function machiningChecks(model: ModelInfo): Check[] {
		const m = model.machining;
		if (!m) {
			return [{ tone: 'info', icon: 'hourglass_top', title: 'Tool Access', badge: 'Analyzing…', detail: 'Checking which surfaces a cutter can reach…' }];
		}
		const p = machiningProfile;
		const list: Check[] = [];
		const four = axisMode.id === 'four';
		const plan = setupPlans![axisMode.id];
		const hidden = plan.hidden;

		if (m.buriedArea >= p.hiddenMinArea) {
			list.push({
				tone: 'info',
				icon: 'join',
				title: 'Overlapping Solids',
				badge: 'Ignored',
				advisory: true,
				detail: `${area(m.buriedArea)} of faces sit inside the part where separate bodies overlap. They're internal, so they're skipped — merging the bodies in CAD gives a cleaner file.`
			});
		}

		const blank = estimate?.stock;
		if (blank?.kind === 'bar' && blank.custom) {
			list.push({
				tone: 'warn',
				icon: 'inventory_2',
				title: 'No Standard Bar Fits',
				badge: 'Custom Stock',
				detail: `The part needs a Ø${mm(blank.size)} × ${mm(blank.length)} mm bar (its reach from the rotary axis and its length, plus ${p.stockMargin} mm margin); none of our standard ${stock.name} bars hold it. It's priced as a custom bar for now and confirmed in review.`
			});
		}
		if (blank?.kind === 'block' && blank.custom) {
			const largest = stock.pieces.reduce((a, b) => (a.x * a.y * a.z >= b.x * b.y * b.z ? a : b));
			list.push({
				tone: 'warn',
				icon: 'inventory_2',
				title: 'No Standard Stock Fits',
				badge: 'Custom Stock',
				detail: `The part needs ${dims(blank.x, blank.y, blank.z)} mm of stock (its footprint plus ${p.stockMargin} mm clamping margin per side, and its full height); our largest ${stock.name} piece is ${dims(largest.x, largest.y, largest.z)} mm. It's priced as a custom block for now and confirmed in review — rotating it to lie flatter may let it fit a standard piece.`
			});
		}

		if (hidden >= plan.threshold) {
			const fourAxisFixes = !four && setupPlans!.four.hidden < setupPlans!.four.threshold;
			list.push(
				fourAxisFixes
					? {
							tone: 'warn',
							icon: 'warning',
							title: 'Undercuts & Side Features',
							badge: 'Try 4-Axis',
							detail: `${area(hidden)} of the surface can't be reached from any side of the stock — features on angled faces or holes at an angle. 4-axis machining turns the part to reach them.`,
							action: { icon: 'sync', label: 'Switch to 4-Axis', onclick: () => setAxes('four') }
						}
					: {
							tone: 'warn',
							icon: 'warning',
							title: 'Unreachable Undercuts',
							badge: 'Redesign',
							detail: `${area(hidden)} of the surface can't be reached ${four ? 'from any angle around the rotary (X) axis or its ends' : 'from any side of the stock, even with 4-axis'} — e.g. internal grooves or T-slots. Those areas would be left uncut: split the part or change the design.${four ? ' Rotating the part so those features face sideways around X may also help.' : ''}`
						}
			);
		} else if (plan.setups > 1) {
			list.push({
				tone: 'info',
				icon: 'flip',
				title: 'Multiple Setups',
				badge: `${plan.setups} Setups`,
				detail: `Machined ${describeSides(plan)}. The stock is flipped and re-clamped between them — included in the estimate.`
			});
		} else {
			list.push({
				tone: 'ok',
				icon: 'check_circle',
				title: 'Tool Access',
				badge: 'Passed',
				detail: four ? 'Every surface is reachable by turning the part around the X axis.' : 'Every surface is reachable from the top in a single setup.'
			});
		}

		if (m.sharpCorners >= 1) {
			const radius = (p.standardTool / 2).toFixed(2);
			const finest = (finestCornerTool / 2).toFixed(2);
			list.push({
				tone: 'info',
				icon: 'rounded_corner',
				title: 'Internal Corners',
				badge: `R${radius} mm`,
				detail: `${m.sharpCorners.toFixed(0)} mm of sharp internal vertical corners. A spinning cutter can't make them square: they come out with an R${radius} mm radius from the Ø${p.standardTool} mm end mill (down to R${finest} mm with the Ø${finestCornerTool} mm cutter, at extra machine time). If a square part has to fit inside, add dog-bone reliefs or fillets in CAD.`
			});
		}

		const pockets = pocketStats(m, pocketCutters);
		if (pockets.narrowArea >= p.hiddenMinArea) {
			list.push({
				tone: 'warn',
				icon: 'warning',
				title: 'Gaps Too Narrow to Cut',
				badge: `Under Ø${pockets.smallest} mm`,
				detail: `${area(pockets.narrowArea)} of floor sits in slots or pockets narrower than our smallest Ø${pockets.smallest} mm end mill, so they can't be cut. Widen them in CAD.`
			});
		}
		if (pockets.worst && pockets.deepArea >= p.hiddenMinArea) {
			const { depth, width, reach } = pockets.worst;
			list.push({
				tone: 'warn',
				icon: 'warning',
				title: 'Pockets Too Deep',
				badge: `${mm(depth)} mm Deep`,
				detail: `A pocket ${mm(depth)} mm deep and ${mm(width)} mm wide is beyond our tools: the longest cutter that fits a ${mm(width)} mm gap only reaches ${mm(reach)} mm. Make it shallower or wider, or reach it from another side.`
			});
		} else if (pockets.deepest) {
			list.push({
				tone: 'ok',
				icon: 'check_circle',
				title: 'Pocket Depth',
				badge: 'Passed',
				detail: `Every pocket is within reach of a cutter that fits it — the deepest is ${mm(pockets.deepest.depth)} mm deep and ${mm(pockets.deepest.width)} mm wide.`
			});
		}
		return list;
	}

	/** "from the top, bottom and front" / "on the rotary, plus the left end". */
	function describeSides(plan: SetupPlan) {
		const join = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
		if (plan.sides[0] === 'rotary') {
			const ends = plan.sides.slice(1);
			return `on the rotary${ends.length ? `, plus the ${join(ends)} ${plural(ends.length, 'end')}` : ''}`;
		}
		return `from the ${join(plan.sides)}`;
	}

	/** True if the part fits the volume in some axis-aligned orientation. */
	function fitsVolume(size: ModelInfo['size'], volume: { x: number; y: number; z: number }) {
		const part = [size.x, size.y, size.z].sort((a, b) => a - b);
		const box = [volume.x, volume.y, volume.z].sort((a, b) => a - b);
		return part.every((d, i) => d <= box[i]);
	}

	let errorCount = $derived(checks.filter((c) => !c.advisory && (c.tone === 'error' || c.tone === 'warn')).length);

	// ---------- Persistence (browser storage) ----------

	/** Bound ModelViewer instance, for mesh export and thumbnails. */
	let viewerRef = $state<ReturnType<typeof ModelViewer>>();
	/** Id of the stored part being edited; null for the sample part or before saving. */
	let partId = $state<string | null>(null);
	/** True once the model for `partId` is loaded, so autosave never writes stale data. */
	let partReady = $state(false);
	let restoring = $state(false);
	let restoreError = $state('');
	/** Name to apply when the restored model finishes loading (instead of the file name). */
	let pendingName: string | null = null;
	const saver = createPartSaver();

	function currentConfig(): PartConfig {
		return {
			mode,
			categoryId,
			materialId,
			colorId: color.id,
			qualityId,
			fdm: { ...fdm },
			resin: { ...resinConfig, pigmentId: pigment.id },
			machining: { ...machiningConfig }
		};
	}

	function applyConfig(config: PartConfig) {
		mode = config.mode;
		categoryId = config.categoryId;
		materialId = config.materialId;
		colorId = config.colorId ?? '';
		qualityId = config.qualityId;
		fdm = { ...recommendedFdm(), ...config.fdm };
		resinConfig = { ...resinDefaults, resinId: catalog.defaults.resinId, ...config.resin };
		machiningConfig = { ...machiningDefaults, materialId: catalog.defaults.stockId, ...config.machining };
	}

	const defaultConfig = (): PartConfig => ({
		mode: 'simple',
		categoryId: catalog.defaults.categoryId,
		materialId: catalog.defaults.materialId,
		qualityId: defaults.qualityId,
		fdm: recommendedFdm(),
		resin: { ...resinDefaults, resinId: catalog.defaults.resinId },
		machining: { ...machiningDefaults, materialId: catalog.defaults.stockId }
	});

	/** Spec chips shown on the Shelf. */
	function specChips(): SpecChip[] {
		if (isCnc) {
			const chips: SpecChip[] = [
				{ icon: 'inventory_2', label: stock.label },
				{ icon: 'precision_manufacturing', label: `${axisMode.label} machining` }
			];
			if (estimate?.stock) chips.push({ icon: 'deployed_code', label: stockSize(estimate.stock) });
			return chips;
		}
		if (isResin) {
			return [
				{ icon: 'palette', label: `${resin.name} — ${pigment.name}` },
				{ icon: 'layers', label: `${Math.round(resinQuality.layerHeight * 1000)} µm layer` },
				{ icon: 'deployed_code', label: shell.hollow ? `Hollow, ${resinProfile.hollowWall.toFixed(1)} mm walls` : 'Solid' },
				{ icon: 'foundation', label: 'Touch-point supports' }
			];
		}
		const chips: SpecChip[] = [
			{ icon: 'palette', label: `${material.name} — ${color.name}` },
			{ icon: 'layers', label: `${quality.layerHeight.toFixed(2)} mm layer` },
			{ icon: 'adjust', label: `${fdm.nozzle.toFixed(1)} mm nozzle` },
			{ icon: 'grid_4x4', label: `${fdm.infill}% ${options.infillPattern.label}` },
			{ icon: 'shield', label: `${fdm.wallLoops} walls` }
		];
		if (options.supportPlacement.coverage > 0) {
			chips.push({ icon: 'foundation', label: `Supports: ${options.supportPlacement.label}` });
		}
		return chips;
	}

	// Keep the page in step with `?part=` — opening a part, or a fresh configurator.
	$effect(() => {
		const id = page.url.searchParams.get('part');
		untrack(() => {
			if (id === partId || (id && restoring)) return;
			if (id) restore(id);
			else if (partId) startFresh();
		});
	});

	async function restore(id: string) {
		restoring = true;
		restoreError = '';
		partReady = false;
		try {
			const [part, mesh, original] = await Promise.all([getPart(id), getMesh(id), getSource(id)]);
			if (!part || !mesh) throw new Error('This part is no longer on your shelf.');
			stepFile = original;
			applyConfig(part.config);
			transform = structuredClone(part.transform);
			quote = part.quote;
			partName = part.name;
			pendingName = part.name;
			lastModelName = null;
			partId = id;
			source = { kind: 'stored', name: part.fileName, mesh, transform: part.transform };
		} catch (err) {
			restoreError = (err as Error).message || 'Could not open this part.';
			partId = null;
		} finally {
			restoring = false;
		}
	}

	function startFresh() {
		partId = null;
		partReady = false;
		quote = null;
		restoreError = '';
		applyConfig(defaultConfig());
		transform = identityTransform();
		source = pendingUpload.file;
		pendingUpload.file = null;
	}

	/** Called by the viewer each time a new model finishes loading. */
	async function handleModelLoad() {
		partReady = false;
		const loaded = source;
		if (isStoredModel(loaded)) {
			partReady = true;
			return;
		}
		if (!(loaded instanceof File)) {
			// Sample part (or a URL): nothing to persist.
			if (partId) goto(page.url.pathname, { replaceState: true, noScroll: true, keepFocus: true });
			partId = null;
			return;
		}

		const [mesh, thumbnail] = await Promise.all([viewerRef?.getMeshData(), viewerRef?.thumbnail()]);
		if (!mesh || source !== loaded) return;
		const now = Date.now();
		const record: PartRecord = {
			id: crypto.randomUUID(),
			name: partName.trim() || baseName(loaded.name),
			fileName: loaded.name,
			format: formatOf(loaded),
			fileSize: loaded.size,
			processId,
			config: currentConfig(),
			transform: $state.snapshot(transform),
			summary: null,
			quote: null,
			thumbnail: thumbnail ?? null,
			createdAt: now,
			updatedAt: now
		};
		try {
			await createPart(record, mesh, keepsSource(record.format) ? loaded : undefined);
		} catch (err) {
			console.error('Could not save part', err);
			return;
		}
		if (source !== loaded) return;
		partId = record.id;
		partReady = true;
		goto(`${page.url.pathname}?part=${record.id}`, { replaceState: true, noScroll: true, keepFocus: true });
	}

	// Autosave every edit to the open part.
	$effect(() => {
		const id = partId;
		if (!id || !partReady || !info || !estimate) return;
		const patch: Partial<PartRecord> = {
			name: partName.trim() || baseName(info.name),
			processId,
			config: currentConfig(),
			transform: $state.snapshot(transform),
			quote,
			summary: {
				size: { ...info.size },
				volume: info.volume,
				triangles: info.triangles,
				issues: errorCount,
				specs: specChips(),
				estimateTotal: estimate.total,
				quotedTotal: quoteCurrent ? quote!.result.total : null
			}
		};
		untrack(() => saver.save(id, patch));
	});

	// Re-render the Shelf thumbnail when the part's look changes.
	$effect(() => {
		const id = partId;
		if (!id || !partReady) return;
		JSON.stringify(transform);
		void partColor;
		const timer = setTimeout(async () => {
			const blob = await viewerRef?.thumbnail();
			if (blob && partId === id) saver.save(id, { thumbnail: blob });
		}, 700);
		return () => clearTimeout(timer);
	});

	onMount(() => {
		const flush = () => saver.flush();
		addEventListener('pagehide', flush);
		return () => {
			removeEventListener('pagehide', flush);
			saver.flush();
		};
	});

	// ---------- Formatting ----------

	function mm(v: number) {
		return v.toFixed(1);
	}

	/** "100 × 150 × 10" — whole millimetres stay whole. */
	function dims(...values: number[]) {
		return values.map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))).join(' × ');
	}

	function stockSize(s: NonNullable<PrintCost['stock']>) {
		if (s.kind === 'bar') {
			const section = s.shape === 'round' ? `Ø${dims(s.size)}` : `${dims(s.size, s.size)}`;
			return `${s.custom ? 'custom ' : ''}${section} × ${dims(s.length)} mm ${s.shape} bar`;
		}
		return s.custom ? `custom ${dims(s.x, s.y, s.z)} mm block` : `${dims(s.x, s.y, s.z)} mm piece`;
	}

	/** Layer heights below 0.1 mm need the third decimal (0.025, 0.050). */
	function layerMm(v: number) {
		return v.toFixed(v < 0.1 ? 3 : 2);
	}

	function percent(v: number) {
		return `${Math.round(v * 100)}%`;
	}

	function mm2(v: number) {
		return v.toFixed(2);
	}

	/** Surface area given in mm², shown in cm² once it's large. */
	function area(mm2: number) {
		return mm2 < 100 ? `${mm2.toFixed(1)} mm²` : `${(mm2 / 100).toFixed(1)} cm²`;
	}

	function money(v: number) {
		return `$${v.toFixed(2)}`;
	}

	/** Prefix with ≈ while the number is only an estimate. */
	function approx(text: string) {
		return quoteCurrent ? text : `≈ ${text}`;
	}

	function duration(hours: number) {
		const h = Math.floor(hours);
		const m = Math.round((hours - h) * 60);
		return `${h} hrs ${m} mins`;
	}

	function plural(n: number, word: string) {
		return n === 1 ? word : `${word}s`;
	}

	function repairSummary(r: RepairReport) {
		const fixes = [
			r.holesFilled && `filled ${r.holesFilled.toLocaleString()} ${plural(r.holesFilled, 'hole')} with ${r.trianglesAdded.toLocaleString()} ${plural(r.trianglesAdded, 'triangle')}`,
			r.degenerateRemoved && `removed ${r.degenerateRemoved.toLocaleString()} degenerate ${plural(r.degenerateRemoved, 'face')}`,
			r.duplicatesRemoved && `removed ${r.duplicatesRemoved.toLocaleString()} duplicate ${plural(r.duplicatesRemoved, 'face')}`,
			r.facesFlipped && `flipped ${r.facesFlipped.toLocaleString()} inverted ${plural(r.facesFlipped, 'face')}`
		].filter(Boolean);
		const what = fixes.length ? fixes.join(', ') : 'tidied the mesh';
		return `${r.openEdgesBefore.toLocaleString()} open edges closed: ${what}. Check the preview to make sure the patches look right.`;
	}

	/** File name without its extension. */
	function baseName(file: string) {
		return file.replace(/\.[^.]+$/, '');
	}

	function signedMm(v: number) {
		return `${v > 0 ? '+' : ''}${v.toFixed(2)} mm`;
	}

	/** Step a value within a range, rounding away float noise. */
	function stepValue(value: number, direction: 1 | -1, range: NumberRange) {
		const decimals = Math.max(0, -Math.floor(Math.log10(range.step)));
		const next = Number((value + direction * range.step).toFixed(decimals));
		return Math.min(range.max, Math.max(range.min, next));
	}

	function resetAdvanced() {
		fdm = recommendedFdm();
		qualityId = defaults.qualityId;
	}

	function selectCategory(id: string) {
		const keepColor = color.name;
		categoryId = id;
		selectMaterial(byId(materialCategories, id).materials[0].id, keepColor);
	}

	/** Switch filament, keeping a color of the same name if the new one has it. */
	function selectMaterial(id: string, keepColor = color.name) {
		const next = byId(category.materials, id);
		materialId = next.id;
		colorId = next.colors.find((c) => c.name === keepColor)?.id ?? '';
	}
</script>

<svelte:head>
	<title>{process.title} — AD-Forge</title>
</svelte:head>

<HelpDialog />

<!-- Process selector ribbon: tiles on wider screens, a dropdown on phones -->
<section class="ribbon">
	<label class="process-select">
		<span class="visually-hidden">Manufacturing method</span>
		<span class="material-symbols-outlined process-icon">{process.icon}</span>
		<select bind:this={methodSelect} value={processId} onchange={(e) => switchProcess(e.currentTarget.value)}>
			{#each processes as p (p.id)}
				<option value={p.id} disabled={p.comingSoon}>
					{p.title} — {p.comingSoon ? 'Coming soon' : p.subtitle}
				</option>
			{/each}
		</select>
		<span class="material-symbols-outlined chevron">expand_more</span>
	</label>
	<div class="process-list">
		{#each processes as p (p.id)}
			{@const active = p.id === processId}
			<svelte:element
				this={p.comingSoon ? 'div' : 'a'}
				class="process"
				class:active
				class:soon={p.comingSoon}
				href={p.comingSoon ? undefined : `/make/${p.id}${partId ? `?part=${partId}` : ''}`}
				aria-current={active ? 'page' : undefined}
				aria-disabled={p.comingSoon || undefined}
				data-sveltekit-noscroll
				data-sveltekit-keepfocus
			>
				<span class="material-symbols-outlined process-icon">{p.icon}</span>
				<span class="process-text">
					<span class="process-title">
						{p.title}
						{#if p.comingSoon}<span class="soon-badge">Coming Soon</span>{/if}
					</span>
					<span class="process-sub">{p.subtitle}</span>
				</span>
			</svelte:element>
		{/each}
	</div>
</section>

<section class="workspace">
	<!-- LEFT: viewport + diagnostics -->
	<div class="col-left">
		<ModelViewer
			bind:this={viewerRef}
			bind:source
			bind:info
			bind:transform
			bind:orientationFit
			accept={isCnc ? '.step,.stp' : undefined}
			color={partColor}
			bed={machineBed}
			{bedLabel}
			machining={isCnc}
			layers={!isCnc}
			{layerHeight}
			{overhangAngle}
			height="620px"
			onload={handleModelLoad}
		/>
		{#if restoring}
			<p class="part-banner"><span class="mini-spinner"></span>Opening part from your shelf…</p>
		{:else if restoreError}
			<p class="part-banner error">
				<span class="material-symbols-outlined">error</span>{restoreError}
				<a href="/shelf">Back to Shelf</a>
			</p>
		{:else if partId}
			<p class="part-banner saved">
				<span class="material-symbols-outlined">cloud_done</span>Saved to your <a href="/shelf">Shelf</a> in this browser. Changes save automatically.
			</p>
		{/if}

		<div class="metric-strip">
			<div class="metric">
				<div class="metric-icon primary"><span class="material-symbols-outlined">verified</span></div>
				<div>
					<span class="caps">{isCnc ? 'Machinability' : 'Printability'}</span>
					<span class="metric-value">{info ? `${errorCount} ${errorCount === 1 ? 'Error' : 'Errors'}` : '—'}</span>
				</div>
			</div>
				<div class="metric">
				{#if isCnc}
					<div class="metric-icon secondary"><span class="material-symbols-outlined">inventory_2</span></div>
					<div>
						<span class="caps">Material Cut</span>
						<span class="metric-value">
							{pricing?.stock ? `${pricing.stock.removedCm3.toFixed(0)} cm³ (${percent(pricing.stock.removedCm3 / pricing.stock.cm3)})` : '—'}
						</span>
					</div>
				{:else}
					<div class="metric-icon secondary"><span class="material-symbols-outlined">layers</span></div>
					<div>
						<span class="caps">{quoteCurrent ? 'Layers' : 'Estimated Layers'}</span>
						<span class="metric-value">{pricing ? `${pricing.layers} Layers @ ${layerMm(layerHeight)}mm` : '—'}</span>
					</div>
				{/if}
			</div>
			<div class="metric">
				<div class="metric-icon tertiary"><span class="material-symbols-outlined">timer</span></div>
				<div>
					<span class="caps">{isCnc ? (quoteCurrent ? 'Machine Time' : 'Est. Machine Time') : quoteCurrent ? '1 Unit Print Time' : 'Est. 1 Unit Print Time'}</span>
					<span class="metric-value">{pricing ? approx(duration(pricing.hours)) : '—'}</span>
				</div>
			</div>
		</div>

		<div class="card health">
			<div class="health-head">
				<div class="health-title">
					<span class="material-symbols-outlined">health_and_safety</span>
					<div>
						<h3>Model Health &amp; Slicing Checks</h3>
						<p class="code-sm">Automated mesh geometry inspection &amp; printability diagnostics</p>
					</div>
				</div>
				<button class="btn-ghost" disabled={!info || info.openEdges === 0 || repairing} onclick={repairModel}>
					{#if repairing}
						<span class="mini-spinner"></span>Repairing…
					{:else}
						<span class="material-symbols-outlined">build</span>Auto-Repair Mesh
					{/if}
				</button>
			</div>
			<div class="checks">
				{#each checks as check (check.title)}
					<div class="check {check.tone}">
						<span class="material-symbols-outlined check-icon">{check.icon}</span>
						<div class="check-body">
							<div class="check-head">
								<span class="check-title">{check.title}</span>
								<span class="check-badge">{check.badge}</span>
							</div>
							<p>{check.detail}</p>
							{#if check.action?.href}
								<a class="check-action" href={check.action.href} data-sveltekit-noscroll>
									<span class="material-symbols-outlined">{check.action.icon}</span>{check.action.label}
								</a>
							{:else if check.action}
								<button class="check-action" onclick={check.action.onclick}>
									<span class="material-symbols-outlined">{check.action.icon}</span>{check.action.label}
								</button>
							{/if}
						</div>
					</div>
				{:else}
					<p class="code-sm empty">Upload a model to run printability checks.</p>
				{/each}
			</div>
		</div>
	</div>

	<!-- RIGHT: parameters + quote -->
	<div class="col-right">
		<div class="card config">
			<label class="name-field">
				<span class="caps">Part Name</span>
				<span class="name-input">
					<span class="material-symbols-outlined">edit</span>
					<input
						type="text"
						bind:value={partName}
						placeholder={info ? baseName(info.name) : 'Untitled part'}
						maxlength="80"
						autocomplete="off"
					/>
				</span>
			</label>

			<div class="config-head">
				<div>
					<span class="caps primary-text">Slicer Controls</span>
					<h2>{isResin ? 'Resin Print Configuration' : isCnc ? 'Machining Configuration' : 'Print Configuration'}</h2>
					<button class="method-link" onclick={openMethodPicker}>
						<span class="material-symbols-outlined">swap_horiz</span>{process.badge} · Change manufacturing method
					</button>
				</div>
				{#if !isResin && !isCnc}
					<div class="mode-switch" role="group" aria-label="Configuration mode">
						<button class:active={mode === 'simple'} onclick={() => (mode = 'simple')}>Simple</button>
						<button class:active={mode === 'advanced'} onclick={() => (mode = 'advanced')}>Advanced</button>
					</div>
				{/if}
			</div>

			{#if isResin}
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">1</span>Photopolymer Resin<HelpButton key="resin" /></span>
						<span class="hint">{catalog.resins.length} {plural(catalog.resins.length, 'Resin')}</span>
					</div>
					<div class="material-box">
						<div class="material-summary">
							<div class="swatch-check" style:background={pigment.hex}>
								<span class="material-symbols-outlined">check</span>
							</div>
							<div class="material-text">
								<div class="material-name">
									<span>{resin.name} — {pigment.name}</span>
									<span class="stock" class:out={!resin.inStock}>{resin.inStock ? 'In Stock' : 'Backorder'}</span>
								</div>
							</div>
							<span class="per-gram">{money(resin.pricePerMl)}<small>/ml</small></span>
						</div>
						{#if !resin.inStock}{@render backorderNote()}{/if}

						<div class="props">
							{#each [['Tensile', resin.tensile], ['Elongation', resin.elongation], ['Heat Deflect', resin.heatDeflect]] as [label, value] (label)}
								<div class="prop">
									<span class="caps">{label}</span>
									<span class="prop-value">{value}</span>
								</div>
							{/each}
						</div>

						<div class="field">
							<span class="caps">Resin Type<HelpButton key="resinType" /></span>
							<span class="select-wrap">
								<select aria-label="Resin type" value={resin.id} onchange={(e) => selectResin(e.currentTarget.value)}>
									{#each catalog.resins as r (r.id)}<option value={r.id}>{r.label}</option>{/each}
								</select>
								<span class="material-symbols-outlined chevron">expand_more</span>
							</span>
						</div>

						<div class="field">
							<span class="caps">Pigment<HelpButton key="pigment" /></span>
							<div class="pigments">
								{#each resin.pigments as p (p.id)}
									<button class="pigment" class:selected={p.id === pigment.id} onclick={() => (resinConfig.pigmentId = p.id)}>
										<span class="pigment-dot" style:background={p.hex}></span>{p.name}
									</button>
								{/each}
							</div>
						</div>
					</div>
				</div>

				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">2</span>Layer Resolution (Z-Pitch)<HelpButton key="resinLayer" /></span>
						<span class="hint">{Math.round(resinQuality.layerHeight * 1000)} µm</span>
					</div>
					<div class="options cols-3">
						{#each resinQualities as q (q.id)}
							<button class="option" class:selected={resinQuality.id === q.id} onclick={() => (resinConfig.qualityId = q.id)}>
								<span class="option-title">{q.label}</span>
								<span class="option-value">{layerMm(q.layerHeight)} mm</span>
								<span class="option-note">{q.note}</span>
							</button>
						{/each}
					</div>
				</div>

				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">3</span>Internal Shell<HelpButton key="resinShell" /></span>
						{#if shell.hollow && hollowSaving > 0.01}
							<span class="metric-accent">−{percent(hollowSaving)} resin</span>
						{/if}
					</div>
					{@render choice(shellStrategies, shell.id, (id) => (resinConfig.shellId = id))}
					<span class="help">
						{#if shell.hollow}
							Hollowed to a {resinProfile.hollowWall.toFixed(1)} mm shell: lighter, and less peel force on the vat. Drain holes are added during review.
						{:else}
							Fully solid for maximum rigidity{info ? ` — ≈${info.volume.toFixed(1)} ml of resin before supports` : ''}.
						{/if}
					</span>
				</div>

				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">4</span>Post-Wash &amp; UV Cure<HelpButton key="resinPost" /></span>
						<span class="hint">Included</span>
					</div>
					<p class="included-note">
						<span class="material-symbols-outlined">clean_hands</span>
						Two-stage IPA wash strips uncured resin, then a 405 nm UV post-cure at 60 °C brings the part to full strength. Supports are removed and contact points sanded smooth.
					</p>
				</div>
			{:else if isCnc}
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">1</span>Stock Material<HelpButton key="stockMaterial" /></span>
						<span class="hint">{catalog.stockMaterials.length} Materials</span>
					</div>
					<div class="material-box">
						<div class="material-summary">
							<div class="swatch-check" style:background={stock.color}>
								<span class="material-symbols-outlined">check</span>
							</div>
							<div class="material-text">
								<div class="material-name">
									<span>{stock.label}</span>
									<span class="stock" class:out={!stock.inStock}>{stock.inStock ? 'In Stock' : 'Backorder'}</span>
								</div>
								<span class="code-sm">{stock.specs}</span>
							</div>
							<span class="per-gram from-price"><small>From</small>{money(stockFromPrice)}</span>
						</div>
						{#if !stock.inStock}{@render backorderNote()}{/if}

						<div class="seg" role="group" aria-label="Material type">
							{#each catalog.stockGroups as g (g.id)}
								<button class:selected={stock.group === g.id} onclick={() => selectStockGroup(g.id)}>
									<span class="seg-label">{g.label}</span>
								</button>
							{/each}
						</div>

						<div class="field">
							<span class="caps">Material<HelpButton key="stockMaterialPick" /></span>
							<span class="select-wrap">
								<select aria-label="Material" value={stock.id} onchange={(e) => (machiningConfig.materialId = e.currentTarget.value)}>
									{#each catalog.stockMaterials.filter((m) => m.group === stock.group) as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
								</select>
								<span class="material-symbols-outlined chevron">expand_more</span>
							</span>
						</div>
					</div>
				</div>

				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">2</span>Machining Axes<HelpButton key="axes" /></span>
						{#if recommendedAxes === 'four' && !onRotary}
							<span class="metric-accent">4-Axis Recommended</span>
						{:else}
							<span class="hint">{money(axisMode.firstSetupFee)} setup · +{money(axisMode.additionalSetupFee)} each extra</span>
						{/if}
					</div>
					{@render choice(axisModes, axisMode.id, (id) => setAxes(id as AxisMode['id']))}
					<span class="help">
						{#if onRotary}
							Cut from a round or square bar that turns on the X axis, so side holes and wrap-around features are reached in one setup. Takes bars up to Ø{rotary.diameter} × {rotary.length} mm.
						{:else}
							Cut straight down into a block, flipping it to reach other sides as needed — each extra side is another setup. Angled features no side can see need 4-axis.{#if setupPlans && setupPlans.three.setups > 1}
								This part needs {setupPlans.three.setups} setups.{/if}
						{/if}
					</span>
				</div>

				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">3</span>Orientation<HelpButton key="orientation" /></span>
						<span class="hint">{onRotary ? 'Rotary on X' : 'Spindle on Z'}</span>
					</div>
					<p class="included-note">
						<span class="material-symbols-outlined">3d_rotation</span>
						{#if onRotary}
							The part turns around the X axis (left to right in the preview). Use the rotate tool to lay its long side along X.
						{:else}
							The cutter comes straight down. Use the rotate tool so most features face up — the checks and price update as you turn it.
						{/if}
					</p>
				</div>
			{:else if mode === 'simple'}
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">1</span>Material &amp; Color<HelpButton key="fdmMaterial" /></span>
						<a class="caps primary-text link" href="/#services">Browse 40+ Tech Polymers</a>
					</div>
					{@render materialPicker()}
				</div>

				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">2</span>Surface Quality (Layer Height)<HelpButton key="layerHeight" /></span>
						<span class="hint">Standard Recommended</span>
					</div>
					{@render qualityPicker()}
				</div>

				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">3</span>Internal Infill Density<HelpButton key="infillDensity" /></span>
						<span class="metric-accent">{fdm.infill}%</span>
					</div>
					<div class="infill-box">{@render infillDensity()}</div>
				</div>

				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step">4</span>Level of Detail (Nozzle Size)<HelpButton key="nozzle" /></span>
						<span class="hint">Standard 0.4mm</span>
					</div>
					{@render nozzlePicker()}
				</div>
			{:else}
				<!-- Material -->
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step icon"><span class="material-symbols-outlined">palette</span></span>Material &amp; Color<HelpButton key="fdmMaterial" /></span>
						<a class="caps primary-text link" href="/#services">Browse 40+ Tech Polymers</a>
					</div>
					{@render materialPicker()}
				</div>

				<!-- Layers & nozzle -->
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step icon"><span class="material-symbols-outlined">layers</span></span>Layers &amp; Nozzle<HelpButton key="layersNozzle" /></span>
						<span class="hint">{quality.layerHeight.toFixed(2)} mm · ⌀{fdm.nozzle.toFixed(1)}</span>
					</div>
					<div class="adv-box">
						<div class="setting">
							<span class="caps">Surface Quality (Layer Height)<HelpButton key="layerHeight" /></span>
							{@render qualityPicker()}
						</div>
						<div class="setting">
							<span class="caps">Nozzle Diameter<HelpButton key="nozzle" /></span>
							{@render nozzlePicker()}
						</div>
					</div>
				</div>

				<!-- Walls & shells -->
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step icon"><span class="material-symbols-outlined">shield</span></span>Walls &amp; Shells<HelpButton key="wallsShells" /></span>
						<span class="hint">{(fdm.wallLoops * fdm.nozzle * profile.lineWidthFactor).toFixed(2)} mm walls</span>
					</div>
					<div class="adv-box">
						<div class="setting-grid">
							<div class="setting">
								<span class="caps">Wall Loops<HelpButton key="wallLoops" /></span>
								<div class="seg compact">
									{#each wallLoopOptions as n (n)}
										<button class:selected={fdm.wallLoops === n} onclick={() => (fdm.wallLoops = n)}>{n}</button>
									{/each}
								</div>
								<span class="help">Side strength &amp; thread engagement.</span>
							</div>
							<div class="setting">
								<span class="caps">Top Shells<HelpButton key="topShells" /></span>
								{@render stepper('top shells', fdm.topShells, shellCountRange, (v) => (fdm.topShells = v), `${fdm.topShells} · ${(fdm.topShells * quality.layerHeight).toFixed(2)}mm`)}
								<span class="help">Prevents pillowing over sparse infill.</span>
							</div>
							<div class="setting">
								<span class="caps">Bottom Shells<HelpButton key="bottomShells" /></span>
								{@render stepper('bottom shells', fdm.bottomShells, shellCountRange, (v) => (fdm.bottomShells = v), `${fdm.bottomShells} · ${(fdm.bottomShells * quality.layerHeight).toFixed(2)}mm`)}
								<span class="help">Floor rigidity &amp; watertight seal.</span>
							</div>
						</div>
						<div class="setting">
							<span class="caps">Wall Printing Order<HelpButton key="wallOrder" /></span>
							{@render choice(wallSequences, fdm.wallSequence, (id) => (fdm.wallSequence = id))}
						</div>
						{@render toggle('Detect Thin Walls', 'detectThinWalls', `Prints features thinner than two lines (< ${(2 * fdm.nozzle * profile.lineWidthFactor).toFixed(2)}mm) as single extrusions.`, fdm.detectThinWalls, (v) => (fdm.detectThinWalls = v))}
					</div>
				</div>

				<!-- Infill -->
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step icon"><span class="material-symbols-outlined">grain</span></span>Infill<HelpButton key="infill" /></span>
						<span class="metric-accent">{fdm.infill}% {options.infillPattern.label}</span>
					</div>
					<div class="adv-box">
						<div class="setting">
							<span class="caps">Density<HelpButton key="infillDensity" /></span>
							{@render infillDensity()}
						</div>
						<div class="setting">
							<span class="caps">Pattern<HelpButton key="infillPattern" /></span>
							{@render select(infillPatterns, fdm.infillPattern, (id) => (fdm.infillPattern = id))}
							<span class="help">{options.infillPattern.note}.</span>
						</div>
					</div>
				</div>

				<!-- Supports -->
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step icon"><span class="material-symbols-outlined">foundation</span></span>Supports<HelpButton key="supports" /></span>
						<span class="hint">{options.supportPlacement.label}</span>
					</div>
					<div class="adv-box">
						<div class="setting">
							<span class="caps">Placement<HelpButton key="supportPlacement" /></span>
							{@render choice(supportPlacements, fdm.supportPlacement, (id) => (fdm.supportPlacement = id))}
						</div>
						<div class="setting" class:muted-setting={fdm.supportPlacement === 'none'}>
							<span class="setting-head">
								<span class="caps">Overhang Threshold<HelpButton key="overhangAngle" /></span>
								<span class="metric-accent">{fdm.overhangAngle}°</span>
							</span>
							<input
								type="range"
								min={overhangRange.min}
								max={overhangRange.max}
								step={overhangRange.step}
								bind:value={fdm.overhangAngle}
								aria-label="Overhang threshold in degrees"
							/>
							<span class="help">Faces steeper than this from vertical get supports. Shown in the overhang view of the preview.</span>
						</div>
						<div class="setting" class:muted-setting={fdm.supportPlacement === 'none'}>
							<span class="caps">Interface Material<HelpButton key="supportInterface" /></span>
							{@render select(catalog.supportInterfaces, fdm.supportInterface, (id) => (fdm.supportInterface = id), fdm.supportPlacement === 'none')}
							<span class="help">{options.supportInterface.note}.</span>
						</div>
					</div>
				</div>

				<!-- Dimensional accuracy -->
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step icon"><span class="material-symbols-outlined">straighten</span></span>Dimensional Accuracy<HelpButton key="dimensionalAccuracy" /></span>
					</div>
					<div class="adv-box">
						<div class="setting-grid two">
							<div class="setting">
								<span class="caps">XY Hole Compensation<HelpButton key="holeCompensation" /></span>
								{@render stepper('hole compensation', fdm.xyHoleCompensation, compensationRange, (v) => (fdm.xyHoleCompensation = v), signedMm(fdm.xyHoleCompensation))}
								<span class="help">Grows holes for press-fit bearings &amp; screws.</span>
							</div>
							<div class="setting">
								<span class="caps">XY Contour Compensation<HelpButton key="contourCompensation" /></span>
								{@render stepper('contour compensation', fdm.xyContourCompensation, compensationRange, (v) => (fdm.xyContourCompensation = v), signedMm(fdm.xyContourCompensation))}
								<span class="help">Offsets outer walls for mating parts.</span>
							</div>
						</div>
					</div>
				</div>

				<!-- Surface finish -->
				<div class="knob">
					<div class="knob-head">
						<span class="knob-title"><span class="step icon"><span class="material-symbols-outlined">brush</span></span>Surface Finish<HelpButton key="surfaceFinish" /></span>
					</div>
					<div class="adv-box">
						{@render toggle('Iron Top Surfaces', 'ironing', 'Extra smoothing pass over flat tops. Adds print time.', fdm.ironing, (v) => (fdm.ironing = v))}
						<div class="setting">
							<span class="caps">Fuzzy Skin<HelpButton key="fuzzySkin" /></span>
							{@render select(fuzzySkinModes, fdm.fuzzySkin, (id) => (fdm.fuzzySkin = id))}
							<span class="help">{options.fuzzySkin.note}.</span>
						</div>
					</div>
				</div>

				<button class="reset-link" onclick={resetAdvanced}>
					<span class="material-symbols-outlined">restart_alt</span>Reset to recommended settings
				</button>
			{/if}

			<!-- Quote -->
			<div class="quote" class:accurate={quoteCurrent} bind:this={quoteCard}>
				<div class="quote-head">
					<span class="caps">Price</span>
					{#if quoteCurrent}
						<span class="quote-badge accurate"><span class="material-symbols-outlined">verified</span>Accurate Quote</span>
					{:else if quoteStale}
						<span class="quote-badge stale"><span class="material-symbols-outlined">sync_problem</span>Settings Changed</span>
					{:else}
						<span class="quote-badge estimate"><span class="material-symbols-outlined">calculate</span>Rough Estimate</span>
					{/if}
				</div>

				<div class="quote-row">
					{#if isCnc}
						<span>Stock ({pricing?.stock ? stockSize(pricing.stock) : '—'}, {stock.name}):</span>
					{:else if isResin}
						<span>Resin ({pricing ? approx(`${(pricing.ml ?? 0).toFixed(1)} ml`) : '—'} {resin.name}):</span>
					{:else}
						<span>Material ({pricing ? approx(`${pricing.grams.toFixed(1)}g`) : '—'} {material.name}):</span>
					{/if}
					<span>{pricing ? approx(money(pricing.materialCost)) : '—'}</span>
				</div>
				<div class="quote-row">
					<span>Machine Time ({pricing ? approx(duration(pricing.hours)) : '—'}):</span>
					<span>{pricing ? approx(money(pricing.machineCost)) : '—'}</span>
				</div>
				<div class="quote-row">
					<span>
						{#if isCnc}
							Setup &amp; Fixturing ({pricing?.stock?.setups ?? 1} {plural(pricing?.stock?.setups ?? 1, 'setup')}):
						{:else}
							{isResin ? 'Platform Prep, Wash & UV Cure:' : 'Automated Slicing & Bed Setup:'}
						{/if}
					</span>
					<span>{pricing ? money(pricing.setupFee) : '—'}</span>
				</div>
				<div class="quote-rule"></div>
				<div class="quote-total">
					<span>{quoteCurrent ? 'Quoted Total:' : 'Estimated Total:'}</span>
					<span class="total" class:muted-total={!quoteCurrent}>{pricing ? approx(money(pricing.total)) : '—'} CAD</span>
				</div>
				{#if pricing}
					{@const lowest = lowestUnitPrice(pricing.total, process.tierScale)}
					{#if lowest}
						<p class="as-low-as">
							<span class="material-symbols-outlined">sell</span>
							<span>As low as <strong>{approx(money(lowest.price))}</strong> each when you order {lowest.tier.label}</span>
						</p>
					{/if}
				{/if}

				<div class="quote-note" class:stale={quoteStale}>
					<span class="material-symbols-outlined">{quoteCurrent ? 'check_circle' : quoteStale ? 'sync_problem' : 'info'}</span>
					<span>
						{#if quoteCurrent}
							Sliced with your exact settings. Price held until {new Date(quote!.result.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.
						{:else if quoteStale}
							You changed settings since your last quote. Get an updated quote to see the accurate price.
						{:else}
							This is a rough estimate from your model's geometry. Get an accurate quote to slice it with your exact settings before ordering.
						{/if}
					</span>
				</div>

				{#if quoteError}
					<p class="quote-error"><span class="material-symbols-outlined">error</span>{quoteError}</p>
				{/if}
				{#if quoteCurrent && finalizeError}
					<p class="quote-error">
						<span class="material-symbols-outlined">error</span>
						<span>{finalizeError}</span>
					</p>
				{/if}

				{#if quoteCurrent && !canSave && !finalizedCurrent && orderable}
					<a class="btn-cta primary" href={signInHref} onclick={signInToConfirm}>
						<span class="material-symbols-outlined">login</span>Sign In &amp; Upload
					</a>
					<p class="cta-hint">Sign in or create a free account to order. We'll bring you straight back and finish the upload; your part and quote are kept.</p>
				{:else if quoteCurrent}
					<button class="btn-cta primary" disabled={finalizing || !orderable} onclick={confirmUpload}>
						{#if finalizing}
							<span class="btn-spinner"></span>Saving Your Design…
						{:else if finalizedCurrent}
							<span class="material-symbols-outlined">add_shopping_cart</span>Add Another to Cart
						{:else}
							<span class="material-symbols-outlined">add_shopping_cart</span>Confirm &amp; Upload
						{/if}
					</button>
					{#if finalizedCurrent}
						<p class="cta-hint">Saved to your <a href="/library">Library</a> and added to your cart.</p>
					{:else if !orderable}
						<p class="cta-hint">Online ordering for {process.title} is coming soon.</p>
					{/if}
				{:else}
					<button class="btn-cta primary" disabled={!canQuote} onclick={getQuote}>
						{#if quoting}
							<span class="btn-spinner"></span>Slicing Your Model…
						{:else}
							<span class="material-symbols-outlined">bolt</span>{quoteStale ? 'Update Accurate Quote' : 'Get Accurate Quote'}
						{/if}
					</button>
					{#if info && !source}
						<p class="cta-hint">This is a sample part — upload your own model to get a quote.</p>
					{:else if cncBlocker}
						<p class="cta-hint">{cncBlocker}</p>
					{:else if info && !fitsMachine}
						<p class="cta-hint">Model doesn't fit the {process.title} build envelope.</p>
					{/if}
				{/if}
			</div>
		</div>

		<div class="card tiers">
			<div class="tiers-head">
				<span class="tiers-title"><span class="material-symbols-outlined">table_chart</span>Batch Pricing Tiers</span>
				<span class="caps">{quoteCurrent ? 'Tiered Discount' : 'Estimated'}</span>
			</div>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Quantity (Units)</th>
							<th class="right">Unit Price</th>
							<th class="center">Savings</th>
						</tr>
					</thead>
					<tbody>
						{#each priceTiers as tier, i (tier.label)}
							<tr class:current={i === 0}>
								<td>
									{#if i === 0}<span class="row-dot"></span>{/if}
									{tier.label}
									{#if i === 0}<span class="current-badge">Current</span>{/if}
								</td>
								<td class="right">{pricing ? approx(money(tierUnitPrice(pricing.total, tier, process.tierScale))) : '—'}</td>
								<td class="center savings">{tier.amountOff ? `${money(tierAmountOff(tier, process.tierScale))} off each` : 'Base Rate'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="tiers-note">
				<span class="material-symbols-outlined">info</span>
				Bulk discounts automatically apply at checkout based on batch quantity.
			</p>
		</div>
	</div>
</section>

<!-- ---------- Shared controls (used by both Simple and Advanced) ---------- -->

{#snippet materialPicker()}
	<div class="material-box">
		<div class="material-summary">
			<div class="swatch-check" style:background={colorHex}>
				<span class="material-symbols-outlined">check</span>
			</div>
			<div class="material-text">
				<div class="material-name">
					<span>{material.name} — {color.name}</span>
					<span class="stock" class:out={!material.inStock}>{material.inStock ? 'In Stock' : 'Backorder'}</span>
				</div>
				<span class="code-sm">
					{material.specs}{#if material.datasheetUrl}
						· <a class="datasheet" href={material.datasheetUrl} target="_blank" rel="noopener">Datasheet</a>{/if}
				</span>
			</div>
			<span class="per-gram">{money(material.pricePerGram)}<small>/g</small></span>
		</div>
		{#if !material.inStock}{@render backorderNote()}{/if}

		<div class="field">
			<span class="caps">Material Category<HelpButton key="materialCategory" /></span>
			<span class="select-wrap">
				<select aria-label="Material category" value={category.id} onchange={(e) => selectCategory(e.currentTarget.value)}>
					{#each materialCategories as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
				</select>
				<span class="material-symbols-outlined chevron">expand_more</span>
			</span>
		</div>

		<div class="field-row">
			<div class="field">
				<span class="caps">Material Polymer<HelpButton key="materialPolymer" /></span>
				<span class="select-wrap">
					<select aria-label="Material polymer" value={material.id} onchange={(e) => selectMaterial(e.currentTarget.value)}>
						{#each category.materials as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
					</select>
					<span class="material-symbols-outlined chevron">expand_more</span>
				</span>
			</div>
			<div class="field">
				<span class="caps">Variant / Color<HelpButton key="color" /></span>
				<span class="select-wrap">
					<span class="dot-swatch" style:background={colorHex}></span>
					<select class="with-swatch" aria-label="Color" value={color.id} onchange={(e) => (colorId = e.currentTarget.value)}>
						{#each baseMaterial.colors as c (c.id)}<option value={c.id}>{c.name}{c.inStock ? '' : ' (Backorder)'}</option>{/each}
					</select>
					<span class="material-symbols-outlined chevron">expand_more</span>
				</span>
			</div>
		</div>
	</div>
{/snippet}

{#snippet backorderNote()}
	<p class="backorder-note" role="status">
		<span class="material-symbols-outlined">local_shipping</span>
		<span>We don't have this material on hand right now. If you place an order, we'll order it from the manufacturer, which may delay processing.</span>
	</p>
{/snippet}

{#snippet qualityPicker()}
	<div class="options cols-3">
		{#each qualities as q (q.id)}
			<button class="option" class:selected={qualityId === q.id} onclick={() => (qualityId = q.id)}>
				<span class="option-title">{q.label}</span>
				<span class="option-value">{q.layerHeight.toFixed(2)} mm</span>
				<span class="option-note">{q.note}</span>
			</button>
		{/each}
	</div>
{/snippet}

{#snippet nozzlePicker()}
	<div class="options cols-4">
		{#each nozzles as n (n.size)}
			{@const allowed = allowedNozzles.includes(n.size)}
			<button
				class="option"
				class:selected={fdm.nozzle === n.size}
				disabled={!allowed}
				title={allowed ? undefined : `${material.name} can't be printed with a ${n.size.toFixed(1)} mm nozzle`}
				onclick={() => (fdm.nozzle = n.size)}
			>
				<span class="option-title">{n.size.toFixed(1)} mm</span>
				<span class="option-note">{allowed ? n.note : 'Not for this material'}</span>
			</button>
		{/each}
	</div>
	{#if allowedNozzles.length < nozzles.length}
		<span class="help">{material.name} prints with {allowedNozzles.map((n) => n.toFixed(1)).join(' / ')} mm nozzles only.</span>
	{/if}
{/snippet}

{#snippet infillDensity()}
	<input
		type="range"
		min={infillRange.min}
		max={infillRange.max}
		step={infillRange.step}
		bind:value={fdm.infill}
		aria-label="Infill density"
	/>
	<div class="presets">
		{#each infillPresets as preset (preset.value)}
			<button class:selected={fdm.infill === preset.value} onclick={() => (fdm.infill = preset.value)}>
				{preset.label}
			</button>
		{/each}
	</div>
{/snippet}

{#snippet stepper(label: string, value: number, range: NumberRange, set: (v: number) => void, display: string)}
	<div class="stepper">
		<button aria-label={`Decrease ${label}`} disabled={value <= range.min} onclick={() => set(stepValue(value, -1, range))}>
			<span class="material-symbols-outlined">remove</span>
		</button>
		<span class="stepper-value">{display}</span>
		<button aria-label={`Increase ${label}`} disabled={value >= range.max} onclick={() => set(stepValue(value, 1, range))}>
			<span class="material-symbols-outlined">add</span>
		</button>
	</div>
{/snippet}

{#snippet choice(items: ChoiceOption[], value: string, set: (id: string) => void)}
	<div class="seg">
		{#each items as item (item.id)}
			<button class:selected={value === item.id} onclick={() => set(item.id)}>
				<span class="seg-label">{item.label}</span>
				<span class="seg-note">{item.note}</span>
			</button>
		{/each}
	</div>
{/snippet}

{#snippet select(items: ChoiceOption[], value: string, set: (id: string) => void, disabled = false)}
	<span class="select-wrap">
		<select {value} {disabled} onchange={(e) => set(e.currentTarget.value)}>
			{#each items as item (item.id)}<option value={item.id}>{item.label}</option>{/each}
		</select>
		<span class="material-symbols-outlined chevron">expand_more</span>
	</span>
{/snippet}

{#snippet toggle(label: string, helpKey: HelpKey, help: string, on: boolean, set: (v: boolean) => void)}
	<div class="toggle-row">
		<span class="toggle-text">
			<span class="caps">{label}<HelpButton key={helpKey} /></span>
			<span class="help">{help}</span>
		</span>
		<button class="switch" class:on role="switch" aria-checked={on} aria-label={label} onclick={() => set(!on)}>
			<span class="knob-dot"></span>
		</button>
	</div>
{/snippet}

{#if showQuoteShortcut}
	<button class="quote-shortcut" class:above-cart={cartBarShown} onclick={scrollToQuote}>
		<span class="material-symbols-outlined">bolt</span>
		{quoteStale ? 'Update Quote' : 'Get Quote'}
		{#if estimate}<span class="shortcut-estimate">≈ {money(estimate.total)}</span>{/if}
	</button>
{/if}

<style>
	/* ---------- Shared text styles ---------- */
	.caps {
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	.primary-text {
		color: var(--primary);
	}

	.datasheet {
		color: var(--primary);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.code-sm {
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 16px;
		letter-spacing: 0.02em;
		color: var(--on-surface-variant);
	}

	.card {
		background: var(--surface-container-lowest);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	/* ---------- Process ribbon ---------- */
	.ribbon {
		padding: var(--space-sm) var(--gutter-desktop);
		background: var(--surface-container-low);
		box-shadow: var(--shadow-sm);
	}

	.process-select {
		position: relative;
		display: flex;
		align-items: center;
	}

	.process-select .process-icon {
		position: absolute;
		left: var(--space-md);
		color: var(--primary);
		pointer-events: none;
	}

	.process-select select {
		padding: var(--space-sm) 2.25rem var(--space-sm) 2.75rem;
		border-radius: var(--radius-lg);
		background: var(--surface-container-lowest);
		box-shadow: var(--shadow-sm);
		font-family: var(--font-sans);
		font-size: 15px;
		line-height: 20px;
		font-weight: 600;
	}

	.process-select .chevron {
		right: var(--space-md);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.process-list {
		display: none;
		align-items: center;
		gap: var(--space-xs);
		overflow-x: auto;
		padding: 0.25rem 0;
		scrollbar-width: none;
	}

	.process {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xs) var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container);
		color: var(--on-surface-variant);
		text-align: left;
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.process:hover:not(.soon) {
		background: var(--surface-container-high);
		color: var(--on-surface);
	}

	.process.active {
		background: var(--surface-container-lowest);
		color: var(--on-surface);
		box-shadow: var(--shadow-sm);
	}

	.process.soon {
		opacity: 0.75;
		cursor: default;
	}

	.process.soon .process-icon {
		color: var(--tertiary);
	}

	.process-icon {
		font-size: 18px;
	}

	.process-text {
		display: flex;
		flex-direction: column;
	}

	.process-title {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 16px;
		line-height: 1;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.process-sub {
		margin-top: 3px;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 14px;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--on-surface-variant);
	}

	.soon-badge {
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
		background: var(--tertiary);
		color: var(--on-tertiary);
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	/* ---------- Workspace grid ---------- */
	.workspace {
		padding: var(--space-md) var(--gutter-desktop) var(--space-xl);
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-lg);
		align-items: start;
	}

	.col-left,
	.col-right {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		min-width: 0;
	}

	/* ---------- Metric strip ---------- */
	.metric-strip {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-sm);
	}

	.metric {
		padding: var(--space-sm);
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		background: var(--surface-container-lowest);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.metric > div:last-child {
		display: flex;
		flex-direction: column;
	}

	.metric .caps {
		font-size: 9px;
	}

	.metric-icon {
		width: 2rem;
		height: 2rem;
		flex-shrink: 0;
		border-radius: var(--radius-md);
		background: var(--surface-container);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.metric-icon .material-symbols-outlined {
		font-size: 18px;
	}

	.metric-icon.primary {
		color: var(--primary);
	}

	.metric-icon.secondary {
		color: var(--secondary);
	}

	.metric-icon.tertiary {
		color: var(--tertiary);
	}

	.metric-value {
		font-family: var(--font-mono);
		font-size: 14px;
		line-height: 20px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--on-surface);
	}

	/* ---------- Health checks ---------- */
	.health {
		padding: var(--space-md);
		border: 1px solid rgb(226 231 255 / 0.6);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.health-head {
		padding-bottom: 0.25rem;
		border-bottom: 1px solid var(--surface-container-highest);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.health-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.health-title > .material-symbols-outlined {
		font-size: 20px;
		color: var(--primary);
	}

	.health h3 {
		font-size: 16px;
		line-height: 1.25;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.health .code-sm {
		font-size: 10px;
	}

	.btn-ghost {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--surface-container-high);
		color: var(--on-surface);
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		transition: background-color 0.15s ease;
	}

	.btn-ghost:hover:not(:disabled) {
		background: var(--surface-container-highest);
	}

	.btn-ghost .material-symbols-outlined {
		font-size: 14px;
	}

	.checks {
		padding-top: 0.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.check {
		padding: 0.5rem;
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		border-radius: var(--radius-md);
		border: 1px solid rgb(226 231 255 / 0.4);
		background: var(--surface-container-lowest);
	}

	.check.info {
		background: var(--surface-container-low);
	}

	.check.warn {
		background: var(--warning-tint);
		border-color: var(--warning-border);
	}

	.check.error {
		background: rgb(255 218 214 / 0.4);
		border-color: rgb(186 26 26 / 0.2);
	}

	.check-icon {
		flex-shrink: 0;
		margin-top: 2px;
		font-size: 18px;
		color: var(--secondary);
	}

	.check.warn .check-icon {
		color: var(--tertiary);
	}

	.check.error .check-icon {
		color: var(--error);
	}

	.check-body {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.check-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.check-title {
		font-size: 13px;
		font-weight: 600;
	}

	.check-badge {
		flex-shrink: 0;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 12px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		background: rgb(134 242 228 / 0.6);
		color: var(--secondary);
	}

	.check.info .check-badge {
		background: var(--secondary-container);
		color: var(--on-secondary-container);
	}

	.check.warn .check-badge {
		background: var(--tertiary-fixed);
		color: var(--on-tertiary-fixed);
	}

	.check.error .check-badge {
		background: var(--error-container);
		color: var(--on-error-container);
	}

	.check p {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 16px;
		color: var(--on-surface-variant);
	}

	.check-action {
		align-self: flex-start;
		margin-top: 0.375rem;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--primary);
		color: var(--on-primary);
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		transition: filter 0.15s ease;
	}

	.check-action:hover {
		filter: brightness(1.1);
	}

	.check-action .material-symbols-outlined {
		font-size: 14px;
	}

	.empty {
		padding: var(--space-sm) 0;
	}

	/* ---------- Config panel ---------- */
	.config {
		padding: var(--space-lg);
		box-shadow: var(--shadow-md);
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
	}

	.config-head {
		padding-bottom: var(--space-sm);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.config-head > div:first-child {
		display: flex;
		flex-direction: column;
	}

	.config-head .caps {
		font-size: 11px;
	}

	.config h2 {
		font-size: 20px;
		line-height: 1.25;
		font-weight: 600;
		letter-spacing: -0.015em;
	}

	.mode-switch {
		display: flex;
		padding: 0.25rem;
		border-radius: var(--radius-lg);
		background: var(--surface-container);
	}

	.mode-switch button {
		padding: 0.25rem var(--space-md);
		border-radius: var(--radius-md);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
		transition: color 0.15s ease;
	}

	.mode-switch button:hover {
		color: var(--on-surface);
	}

	.mode-switch button.active {
		background: var(--surface-container-lowest);
		color: var(--on-surface);
		box-shadow: var(--shadow-sm);
	}

	.knob {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.knob-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.knob-title {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 16px;
		line-height: 24px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.step {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 50%;
		background: var(--primary-tint);
		color: var(--primary);
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 700;
	}

	.link:hover {
		text-decoration: underline;
	}

	.hint {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--secondary);
	}

	.metric-accent {
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 700;
		color: var(--primary);
	}

	/* Material box */
	.material-box {
		padding: var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container-low);
		border: 1px solid rgb(226 231 255 / 0.6);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.material-summary {
		margin-bottom: var(--space-xs);
		padding: var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
		box-shadow: var(--shadow-sm);
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.swatch-check {
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border-radius: 50%;
		box-shadow:
			0 0 0 2px rgb(163 57 0 / 0.4),
			inset 0 2px 4px rgb(0 0 0 / 0.1);
		display: flex;
		align-items: center;
		justify-content: center;
		color: #fff;
		transition: background-color 0.2s ease;
	}

	.swatch-check .material-symbols-outlined {
		font-size: 14px;
		filter: drop-shadow(0 0 1px rgb(0 0 0 / 0.6));
	}

	.material-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.material-name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		font-weight: 600;
		line-height: 1.2;
	}

	.stock {
		padding: 1px 0.25rem;
		border-radius: var(--radius-sm);
		background: var(--surface-container-high);
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.06em;
	}

	.per-gram {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 700;
		color: var(--primary);
	}

	.per-gram small {
		font-size: 11px;
		font-weight: 400;
		color: var(--on-surface-variant);
	}

	/* "FROM" caption stacked over the price. */
	.from-price {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		line-height: 18px;
	}

	.from-price small {
		font-size: 9px;
		line-height: 12px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.field-row {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-xs);
	}

	.select-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	select {
		width: 100%;
		padding: 0.375rem 1.75rem 0.375rem var(--space-sm);
		appearance: none;
		border: 1px solid var(--surface-container-highest);
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
		color: var(--on-surface);
		font-family: var(--font-mono);
		font-size: 11px;
		cursor: pointer;
		text-overflow: ellipsis;
	}

	select:focus {
		outline: none;
		box-shadow: 0 0 0 1px var(--primary);
	}

	select.with-swatch {
		padding-left: 1.75rem;
	}

	.chevron {
		position: absolute;
		right: 0.5rem;
		font-size: 16px;
		color: var(--on-surface-variant);
		pointer-events: none;
	}

	.dot-swatch {
		position: absolute;
		left: 0.625rem;
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.1);
		pointer-events: none;
	}

	/* Resin properties & pigments */
	.props {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--space-xs);
	}

	.prop {
		padding: 0.375rem var(--space-xs);
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
		border: 1px solid var(--surface-container-highest);
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}

	.prop .caps {
		font-size: 9px;
	}

	.prop-value {
		font-family: var(--font-mono);
		font-size: 13px;
		line-height: 18px;
		font-weight: 600;
		color: var(--on-surface);
	}

	.pigments {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}

	.pigment {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem var(--space-sm);
		border-radius: var(--radius-md);
		border: 1px solid var(--surface-container-highest);
		background: var(--surface-container-lowest);
		color: var(--on-surface-variant);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 16px;
		transition:
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.pigment:hover {
		color: var(--on-surface);
	}

	.pigment.selected {
		border-color: var(--primary);
		color: var(--on-surface);
		font-weight: 600;
		box-shadow: 0 0 0 1px var(--primary);
	}

	.pigment-dot {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 50%;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.15);
	}

	.included-note {
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container-low);
		display: flex;
		align-items: flex-start;
		gap: var(--space-sm);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 17px;
		color: var(--on-surface-variant);
	}

	.backorder-note {
		margin: 0;
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-lg);
		background: var(--warning-tint);
		display: flex;
		align-items: flex-start;
		gap: var(--space-sm);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 16px;
		color: var(--on-surface-variant);
	}

	.backorder-note .material-symbols-outlined {
		flex-shrink: 0;
		font-size: 18px;
		color: var(--tertiary);
	}

	.included-note .material-symbols-outlined {
		flex-shrink: 0;
		font-size: 18px;
		color: var(--primary);
	}

	/* Option tiles (quality / nozzle) */
	.options {
		display: grid;
		gap: var(--space-xs);
	}

	.cols-3 {
		grid-template-columns: repeat(3, 1fr);
	}

	.cols-4 {
		grid-template-columns: repeat(2, 1fr);
	}

	.option {
		position: relative;
		overflow: hidden;
		padding: var(--space-sm);
		border-radius: var(--radius-lg);
		background: var(--surface-container);
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		transition: background-color 0.15s ease;
	}

	.option:hover:not(:disabled) {
		background: var(--surface-container-high);
	}

	.option.selected {
		background: var(--surface-container-highest);
		box-shadow: var(--shadow-sm);
	}

	.option.selected::before {
		content: '';
		position: absolute;
		inset: 0 0 auto 0;
		height: 0.25rem;
		background: var(--primary);
	}

	.option-title {
		font-size: 16px;
		line-height: 24px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.option.selected .option-title {
		color: var(--primary);
		font-weight: 700;
	}

	.option-value {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--on-surface-variant);
	}

	.option.selected .option-value {
		color: var(--on-surface);
		font-weight: 600;
	}

	.option-note {
		margin-top: 0.25rem;
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	.option.selected .option-note {
		color: var(--primary);
	}

	/* Infill */
	.infill-box {
		padding: var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container-low);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	input[type='range'] {
		width: 100%;
		accent-color: var(--primary);
		cursor: pointer;
	}

	.presets {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.375rem;
	}

	.presets button {
		padding: 0.25rem 0.375rem;
		border-radius: var(--radius-md);
		background: var(--surface-container);
		color: var(--on-surface-variant);
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 14px;
		font-weight: 500;
		text-align: center;
		transition: color 0.15s ease;
	}

	.presets button:hover {
		color: var(--on-surface);
	}

	.presets button.selected {
		background: var(--surface-container-lowest);
		color: var(--on-surface);
		font-weight: 700;
		box-shadow: var(--shadow-sm);
	}

	/* Quote */
	.quote {
		padding: var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container);
		box-shadow: inset 0 2px 4px rgb(0 0 0 / 0.05);
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.quote-row {
		display: flex;
		justify-content: space-between;
		gap: var(--space-sm);
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 16px;
		color: var(--on-surface-variant);
	}

	.quote-rule {
		height: 1px;
		margin: 0.125rem 0;
		background: var(--surface-container-highest);
	}

	.as-low-as {
		margin-top: calc(-1 * var(--space-xs));
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: var(--space-xs) var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--secondary-tint);
		color: var(--on-secondary-container);
		font-size: 12px;
		line-height: 16px;
	}

	.as-low-as .material-symbols-outlined {
		font-size: 16px;
	}

	.quote-total {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 16px;
		font-weight: 600;
	}

	.total {
		font-family: var(--font-mono);
		font-size: 20px;
		line-height: 26px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--primary);
	}

	.quote.accurate {
		background: rgb(134 242 228 / 0.18);
		box-shadow: inset 0 0 0 1px rgb(0 106 97 / 0.25);
	}

	.quote-head {
		margin-bottom: 0.25rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.quote-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.quote-badge .material-symbols-outlined {
		font-size: 12px;
	}

	.quote-badge.estimate {
		background: var(--tertiary-fixed);
		color: var(--on-tertiary-fixed);
	}

	.quote-badge.stale {
		background: var(--error-container);
		color: var(--on-error-container);
	}

	.quote-badge.accurate {
		background: var(--secondary-container);
		color: var(--on-secondary-container);
	}

	.muted-total {
		opacity: 0.8;
	}

	.quote-note {
		margin-top: var(--space-xs);
		padding: var(--space-sm);
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
		font-size: 12px;
		line-height: 16px;
		color: var(--on-surface-variant);
	}

	.quote-note .material-symbols-outlined {
		flex-shrink: 0;
		font-size: 16px;
		color: var(--tertiary);
	}

	.quote.accurate .quote-note .material-symbols-outlined {
		color: var(--secondary);
	}

	.quote-note.stale {
		background: rgb(255 218 214 / 0.5);
		color: var(--on-error-container);
	}

	.quote-note.stale .material-symbols-outlined {
		color: var(--error);
	}

	.quote-error {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 12px;
		color: var(--error);
	}

	.quote-error .material-symbols-outlined {
		font-size: 16px;
	}

	.quote .btn-cta {
		margin-top: var(--space-sm);
		padding: var(--space-md);
		font-size: 12px;
	}

	.cta-hint {
		font-size: 11px;
		line-height: 16px;
		text-align: center;
		color: var(--on-surface-variant);
	}

	.btn-spinner {
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		border: 2px solid rgb(255 255 255 / 0.35);
		border-top-color: var(--on-primary);
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.stock.out {
		background: var(--tertiary-fixed);
		color: var(--on-tertiary-fixed);
	}

	.btn-cta {
		width: 100%;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container-lowest);
		color: var(--on-surface);
		box-shadow: var(--shadow-sm);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		transition:
			background-color 0.15s ease,
			transform 0.1s ease;
	}

	a.btn-cta {
		text-decoration: none;
	}

	.btn-cta .material-symbols-outlined {
		font-size: 18px;
	}

	.btn-cta:hover:not(:disabled) {
		background: var(--surface-container-high);
	}

	.btn-cta:active:not(:disabled) {
		transform: scale(0.98);
	}

	.btn-cta.primary {
		background: var(--primary);
		color: var(--on-primary);
		box-shadow: var(--shadow-md);
	}

	.btn-cta.primary:hover:not(:disabled) {
		background: var(--primary-container);
	}

	/* Tiers */
	.tiers {
		padding: var(--space-md);
		background: var(--surface-container-low);
		border: 1px solid rgb(226 231 255 / 0.6);
		box-shadow: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.tiers-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.tiers-title {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 16px;
		line-height: 24px;
		font-weight: 600;
	}

	.tiers-title .material-symbols-outlined {
		font-size: 18px;
		color: var(--primary);
	}

	.table-wrap {
		overflow-x: auto;
		border: 1px solid var(--surface-container-highest);
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		text-align: left;
		font-family: var(--font-mono);
		font-size: 11px;
	}

	th {
		padding: 0.375rem 0.625rem;
		background: var(--surface-container);
		border-bottom: 1px solid var(--surface-container-highest);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	td {
		padding: 0.375rem 0.625rem;
		font-weight: 500;
	}

	tbody tr + tr {
		border-top: 1px solid rgb(218 226 253 / 0.6);
	}

	tbody tr:not(.current):hover {
		background: var(--surface-container-low);
	}

	tr.current {
		background: rgb(163 57 0 / 0.05);
		color: var(--primary);
		font-weight: 600;
	}

	td.right,
	th.right {
		text-align: right;
		font-weight: 600;
	}

	tr.current td.right {
		font-weight: 700;
	}

	td.center,
	th.center {
		text-align: center;
	}

	.savings {
		font-weight: 600;
		color: var(--secondary);
	}

	tr.current .savings {
		font-weight: 400;
		color: var(--on-surface-variant);
	}

	.row-dot {
		display: inline-block;
		width: 0.375rem;
		height: 0.375rem;
		margin-right: 0.375rem;
		border-radius: 50%;
		background: var(--primary);
		vertical-align: middle;
	}

	.current-badge {
		margin-left: 0.375rem;
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
		background: var(--primary-tint);
		font-size: 9px;
		letter-spacing: 0.06em;
	}

	.tiers-note {
		padding-top: 0.125rem;
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 14px;
		color: var(--on-surface-variant);
	}

	.tiers-note .material-symbols-outlined {
		font-size: 14px;
		color: var(--secondary);
	}

	/* Part name */
	.name-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding-bottom: var(--space-md);
		border-bottom: 1px solid var(--surface-container-highest);
	}

	.name-input {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 0 var(--space-sm);
		border: 1px solid var(--surface-container-highest);
		border-radius: var(--radius-md);
		background: var(--surface-container-low);
		transition:
			border-color 0.15s ease,
			background-color 0.15s ease;
	}

	.name-input:focus-within {
		border-color: var(--primary);
		background: var(--surface-container-lowest);
	}

	.name-input .material-symbols-outlined {
		font-size: 16px;
		color: var(--on-surface-variant);
	}

	.name-input input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0;
		border: none;
		outline: none;
		background: none;
		font: inherit;
		font-size: 16px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--on-surface);
	}

	.name-input input::placeholder {
		color: var(--on-surface-variant);
		font-weight: 500;
		opacity: 0.7;
	}

	/* Advanced sections */
	.step.icon .material-symbols-outlined {
		font-size: 13px;
	}

	.adv-box {
		padding: var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container-low);
		border: 1px solid rgb(226 231 255 / 0.6);
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.setting {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}

	.setting-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.muted-setting {
		opacity: 0.5;
	}

	.setting-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-md);
	}

	.help {
		font-size: 11px;
		line-height: 15px;
		color: var(--on-surface-variant);
	}

	/* Segmented choice */
	.seg {
		display: grid;
		grid-auto-columns: 1fr;
		grid-auto-flow: column;
		gap: 2px;
		padding: 2px;
		border-radius: var(--radius-lg);
		background: var(--surface-container);
	}

	.seg button {
		padding: 0.375rem var(--space-xs);
		border-radius: var(--radius-md);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1px;
		text-align: center;
		color: var(--on-surface-variant);
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.seg button:hover {
		color: var(--on-surface);
	}

	.seg button.selected {
		background: var(--surface-container-lowest);
		color: var(--primary);
		box-shadow: var(--shadow-sm);
	}

	.seg-label {
		font-size: 12px;
		font-weight: 600;
		line-height: 16px;
	}

	.seg-note {
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 12px;
		color: var(--on-surface-variant);
	}

	.seg.compact button {
		padding: 0.3rem 0;
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 600;
	}

	/* Stepper */
	.stepper {
		display: flex;
		align-items: center;
		border: 1px solid var(--surface-container-highest);
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
	}

	.stepper button {
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--on-surface-variant);
	}

	.stepper button:hover:not(:disabled) {
		color: var(--primary);
	}

	.stepper button .material-symbols-outlined {
		font-size: 16px;
	}

	.stepper-value {
		flex: 1;
		text-align: center;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		white-space: nowrap;
	}

	/* Toggle switch */
	.toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
	}

	.toggle-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.switch {
		position: relative;
		width: 2.25rem;
		height: 1.25rem;
		flex-shrink: 0;
		border-radius: 999px;
		background: var(--surface-container-highest);
		transition: background-color 0.15s ease;
	}

	.switch.on {
		background: var(--primary);
	}

	.knob-dot {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		background: #fff;
		box-shadow: var(--shadow-sm);
		transition: transform 0.15s ease;
	}

	.switch.on .knob-dot {
		transform: translateX(1rem);
	}

	select:disabled {
		cursor: not-allowed;
	}

	/* Floating shortcut to the price card: where the cart bar sits, or just above it when that's showing. */
	.quote-shortcut {
		--base: calc(var(--space-lg) + env(safe-area-inset-bottom, 0px));
		position: fixed;
		left: 50%;
		bottom: var(--base);
		z-index: 40;
		transform: translate(-50%, -50%);
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: var(--space-sm) var(--space-lg);
		border-radius: var(--radius-full);
		background: var(--primary);
		color: var(--on-primary);
		box-shadow: var(--shadow-md);
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 18px;
		font-weight: 600;
		letter-spacing: 0.04em;
		white-space: nowrap;
		animation: shortcut-in 0.2s ease-out;
	}

	.quote-shortcut.above-cart {
		bottom: calc(var(--base) + 3.5rem);
	}

	.quote-shortcut:hover {
		background: var(--primary-container);
	}

	.quote-shortcut .material-symbols-outlined {
		font-size: 18px;
	}

	.shortcut-estimate {
		padding-left: 0.375rem;
		border-left: 1px solid rgb(255 255 255 / 0.35);
		font-weight: 500;
		opacity: 0.85;
	}

	@keyframes shortcut-in {
		from {
			opacity: 0;
			transform: translate(-50%, 0.5rem);
		}
	}

	/* Same spot as the phone-sized cart bar. */
	@media (max-width: 640px) {
		.quote-shortcut {
			--base: calc(var(--space-xl) + env(safe-area-inset-bottom, 0px));
		}
	}

	/* Phones: title, method link and Simple / Advanced each get their own row. */
	@media (max-width: 767px) {
		.config-head {
			flex-direction: column;
			align-items: stretch;
		}

		.mode-switch button {
			flex: 1;
			padding-block: 0.375rem;
		}
	}

	/* Phones only: the method dropdown is scrolled out of sight by the time you reach the settings. */
	.method-link {
		white-space: nowrap;
		margin-top: 0.25rem;
		align-self: flex-start;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--primary);
	}

	.method-link .material-symbols-outlined {
		font-size: 16px;
	}

	.reset-link {
		align-self: center;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--on-surface-variant);
	}

	.reset-link:hover {
		color: var(--primary);
	}

	.reset-link .material-symbols-outlined {
		font-size: 16px;
	}

	/* Part save status */
	.part-banner {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--surface-container-low);
		font-size: 12px;
		line-height: 16px;
		color: var(--on-surface-variant);
	}

	.part-banner .material-symbols-outlined {
		font-size: 16px;
	}

	.part-banner.saved .material-symbols-outlined {
		color: var(--secondary);
	}

	.part-banner.error {
		background: rgb(255 218 214 / 0.5);
		color: var(--on-error-container);
	}

	.part-banner.error .material-symbols-outlined {
		color: var(--error);
	}

	.part-banner a {
		font-weight: 600;
		color: var(--primary);
	}

	.part-banner a:hover {
		text-decoration: underline;
	}

	.mini-spinner {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		border: 2px solid var(--surface-container-highest);
		border-top-color: var(--primary);
		animation: spin 0.8s linear infinite;
	}

	/* ---------- Breakpoints ---------- */
	@media (min-width: 640px) {
		.field-row {
			grid-template-columns: repeat(2, 1fr);
		}

		.cols-4 {
			grid-template-columns: repeat(4, 1fr);
		}

		.setting-grid {
			grid-template-columns: repeat(3, 1fr);
		}

		.setting-grid.two {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (min-width: 768px) {
		.process-select,
		.method-link {
			display: none;
		}

		.process-list {
			display: flex;
		}

		.metric-strip {
			grid-template-columns: repeat(3, 1fr);
		}
	}

	@media (min-width: 1280px) {
		.workspace {
			grid-template-columns: 7fr 5fr;
		}
	}
</style>
