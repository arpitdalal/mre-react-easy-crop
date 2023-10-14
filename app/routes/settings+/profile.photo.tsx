import { conform, useForm } from '@conform-to/react'
import { getFieldsetConstraint, parse } from '@conform-to/zod'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import {
	json,
	redirect,
	unstable_createMemoryUploadHandler,
	unstable_parseMultipartFormData,
	type DataFunctionArgs,
	type MetaFunction,
} from '@remix-run/node'
import {
	Form,
	useActionData,
	useLoaderData,
	useNavigation,
} from '@remix-run/react'
import { useRef, useState } from 'react'
import Cropper, { type Area, type Point } from 'react-easy-crop'
import { AuthenticityTokenInput } from 'remix-utils/csrf/react'
import { z } from 'zod'
import { ErrorList } from '#app/components/forms.tsx'
import { Button } from '#app/components/ui/button.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { type BreadcrumbHandle } from '#app/routes/settings+/profile.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { validateCSRF } from '#app/utils/csrf.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import {
	getUserImgSrc,
	invariantResponse,
	useDoubleCheck,
	useIsPending,
} from '#app/utils/misc.tsx'

export const handle: BreadcrumbHandle & SEOHandle = {
	breadcrumb: <Icon name="avatar">Photo</Icon>,
}

const MAX_SIZE = 1024 * 1024 * 3 // 3MB

const DeleteImageSchema = z.object({
	intent: z.literal('delete'),
})
const NewImageSchema = z.object({
	intent: z.literal('submit'),
	photoFile: z
		.instanceof(File)
		.refine(file => file.size > 0, 'Image is required')
		.refine(file => file.size <= MAX_SIZE, 'Image size must be less than 3MB'),
})

const PhotoFormSchema = z.union([DeleteImageSchema, NewImageSchema])

export async function loader({ request }: DataFunctionArgs) {
	const userId = await requireUserId(request)
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: {
			id: true,
			name: true,
			username: true,
			image: { select: { id: true } },
		},
	})
	invariantResponse(user, 'User not found', { status: 404 })
	return json({ user })
}

export async function action({ request }: DataFunctionArgs) {
	const userId = await requireUserId(request)
	const formData = await unstable_parseMultipartFormData(
		request,
		unstable_createMemoryUploadHandler({ maxPartSize: MAX_SIZE }),
	)
	await validateCSRF(formData, request.headers)

	const submission = await parse(formData, {
		schema: PhotoFormSchema.transform(async data => {
			if (data.intent === 'delete') return { intent: 'delete' }
			if (data.photoFile.size <= 0) return z.NEVER
			return {
				intent: data.intent,
				image: {
					contentType: data.photoFile.type,
					blob: Buffer.from(await data.photoFile.arrayBuffer()),
				},
			}
		}),
		async: true,
	})

	if (submission.intent !== 'submit') {
		return json({ status: 'idle', submission } as const)
	}
	if (!submission.value) {
		return json({ status: 'error', submission } as const, { status: 400 })
	}

	const { image, intent } = submission.value

	if (intent === 'delete') {
		await prisma.userImage.deleteMany({ where: { userId } })
		return redirect('/settings/profile')
	}

	await prisma.$transaction(async $prisma => {
		await $prisma.userImage.deleteMany({ where: { userId } })
		await $prisma.user.update({
			where: { id: userId },
			data: { image: { create: image } },
		})
	})

	return redirect('/settings/profile')
}

export default function PhotoRoute() {
	const data = useLoaderData<typeof loader>()
	const doubleCheckDeleteImage = useDoubleCheck()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const [newImageSrc, setNewImageSrc] = useState<string | null>(null)
	const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
	const [croppedArea, setCroppedArea] = useState<Area | null>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)

	const [form, fields] = useForm({
		id: 'profile-photo',
		constraint: getFieldsetConstraint(PhotoFormSchema),
		lastSubmission: actionData?.submission,
		onValidate({ formData }) {
			// otherwise, the best error zod gives us is "Invalid input" which is not enough
			if (formData.get('intent') === 'delete') {
				return parse(formData, { schema: DeleteImageSchema })
			}
			return parse(formData, { schema: NewImageSchema })
		},
		shouldRevalidate: 'onBlur',
	})

	async function onCropComplete(_: Area, croppedAreaPixels: Area) {
		try {
			const imgFile = getCroppedImg(newImageSrc ?? '', croppedAreaPixels)
			if (!imgFile || !fileInputRef.current) return
			const dataTransfer = new DataTransfer()
			dataTransfer.items.add(imgFile)
			fileInputRef.current.files = dataTransfer.files
		} catch (error) {
			console.error(error)
		}
	}
	const isPending = useIsPending()
	const pendingIntent = isPending ? navigation.formData?.get('intent') : null
	const lastSubmissionIntent = actionData?.submission.value?.intent

	return (
		<Form
			method="POST"
			encType="multipart/form-data"
			className="flex flex-col items-center justify-center gap-10"
			onReset={() => setNewImageSrc(null)}
			{...form.props}
		>
			<AuthenticityTokenInput />
			{croppedArea && newImageSrc ? (
				<Output croppedArea={croppedArea} ogImage={newImageSrc} />
			) : (
				<img
					src={
						newImageSrc ?? (data.user ? getUserImgSrc(data.user.image?.id) : '')
					}
					className="h-52 w-52 rounded-full object-cover"
					alt={data.user?.name ?? data.user?.username}
				/>
			)}
			<ErrorList errors={fields.photoFile.errors} id={fields.photoFile.id} />
			{newImageSrc ? (
				<div className="container relative h-96 max-w-md">
					<Cropper
						image={newImageSrc}
						crop={crop}
						aspect={1}
						onCropChange={setCrop}
						onCropComplete={onCropComplete}
						onCropAreaChange={setCroppedArea}
					/>
				</div>
			) : null}
			<div className="flex gap-4">
				{/*
						We're doing some kinda odd things to make it so this works well
						without JavaScript. Basically, we're using CSS to ensure the right
						buttons show up based on the input's "valid" state (whether or not
						an image has been selected). Progressive enhancement FTW!
					*/}
				<input
					{...conform.input(fields.photoFile, { type: 'file' })}
					ref={fileInputRef}
					accept="image/*"
					className="peer sr-only"
					required
					tabIndex={newImageSrc ? -1 : 0}
					onChange={e => {
						const file = e.currentTarget.files?.[0]
						if (file) {
							const reader = new FileReader()
							reader.onload = event => {
								setNewImageSrc(event.target?.result?.toString() ?? null)
							}
							reader.readAsDataURL(file)
						}
					}}
				/>
				<Button
					asChild
					className="cursor-pointer peer-valid:hidden peer-focus-within:ring-4 peer-focus-visible:ring-4"
				>
					<label htmlFor={fields.photoFile.id}>
						<Icon name="pencil-1">Change</Icon>
					</label>
				</Button>
				<StatusButton
					name="intent"
					value="submit"
					type="submit"
					className="peer-invalid:hidden"
					status={
						pendingIntent === 'submit'
							? 'pending'
							: lastSubmissionIntent === 'submit'
							? actionData?.status ?? 'idle'
							: 'idle'
					}
				>
					Save Photo
				</StatusButton>
				<Button
					type="reset"
					variant="destructive"
					className="peer-invalid:hidden"
				>
					<Icon name="trash">Reset</Icon>
				</Button>
				{data.user.image?.id ? (
					<StatusButton
						className="peer-valid:hidden"
						variant="destructive"
						{...doubleCheckDeleteImage.getButtonProps({
							type: 'submit',
							name: 'intent',
							value: 'delete',
						})}
						status={
							pendingIntent === 'delete'
								? 'pending'
								: lastSubmissionIntent === 'delete'
								? actionData?.status ?? 'idle'
								: 'idle'
						}
					>
						<Icon name="trash">
							{doubleCheckDeleteImage.doubleCheck ? 'Are you sure?' : 'Delete'}
						</Icon>
					</StatusButton>
				) : null}
			</div>
			<ErrorList errors={form.errors} />
		</Form>
	)
}

function Output({
	croppedArea,
	ogImage,
}: {
	croppedArea: Area
	ogImage: string
}) {
	const scale = 100 / croppedArea.width
	const transform = {
		x: `${-croppedArea.x * scale}%`,
		y: `${-croppedArea.y * scale}%`,
		scale,
		width: 'calc(100% + 0.5px)',
		height: 'auto',
	}

	const imageStyle = {
		transform: `translate3d(${transform.x}, ${transform.y}, 0) scale3d(${transform.scale},${transform.scale},1)`,
		width: transform.width,
		height: transform.height,
	}

	return (
		<div className="h-52 w-52 overflow-hidden rounded-full object-cover">
			<img src={ogImage} alt="" style={imageStyle} />
		</div>
	)
}

export const meta: MetaFunction = () => [
	{ title: 'Change profile picture | 𝕏 Man' },
]

function convertBase64ToFile(base64: string, filename: string): File {
	const arr = base64.split(',')
	const mime = arr[0].match(/:(.*?);/)![1]
	const bstr = atob(arr[1])
	let n = bstr.length
	const u8arr = new Uint8Array(n)
	while (n--) {
		u8arr[n] = bstr.charCodeAt(n)
	}
	return new File([u8arr], filename, { type: mime })
}

function getCroppedImg(imageSrc: string, pixelCrop: Area) {
	const image = new Image()
	image.src = imageSrc
	const canvas = document.createElement('canvas')
	const ctx = canvas.getContext('2d')

	if (!ctx) {
		return null
	}

	// set canvas size to match the bounding box
	canvas.width = image.width
	canvas.height = image.height

	// translate canvas context to a central location to allow rotating and flipping around the center
	ctx.translate(image.width / 2, image.height / 2)
	ctx.translate(-image.width / 2, -image.height / 2)

	// draw rotated image
	ctx.drawImage(image, 0, 0)

	const croppedCanvas = document.createElement('canvas')

	const croppedCtx = croppedCanvas.getContext('2d')

	if (!croppedCtx) {
		return null
	}

	// Set the size of the cropped canvas
	croppedCanvas.width = pixelCrop.width
	croppedCanvas.height = pixelCrop.height

	// Draw the cropped image onto the new canvas
	croppedCtx.drawImage(
		canvas,
		pixelCrop.x,
		pixelCrop.y,
		pixelCrop.width,
		pixelCrop.height,
		0,
		0,
		pixelCrop.width,
		pixelCrop.height,
	)

	const base64string = croppedCanvas.toDataURL('image/jpeg')
	return convertBase64ToFile(base64string, 'file.jpeg')
}
