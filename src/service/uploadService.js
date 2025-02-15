import {
	instance
} from "../yeim-uni-sdk";

import {
	successHandle,
	errHandle
} from '../func/callback';

import md5 from '../utils/md5';

import log from '../func/log';

import CryptoJS from '../utils/CryptoJS';


/**
 * 获取媒体上传参数
 */
async function getMediaUploadParams() {
	let response = await uni.request({
		url: instance.defaults.baseURL + "/upload/sign",
		data: {},
		method: 'GET',
		header: {
			'content-type': 'application/json',
			'token': instance.token
		}
	});
	if (Object.prototype.toString.call(response) === '[object Array]') {
		response = response.pop();
	}
	if (!response || !response.data || !response.data.data) {
		log(1, "媒体上传参数获取失败！");
	} else {
		let data = response.data.data;
		instance.mediaUploadParams = data;
	}
}

/**
 * 获取上传URL
 */
function getUploadURL() {
	let url = "";
	if (instance.mediaUploadParams.storage == "cos") {
		url = "https://" + instance.mediaUploadParams.bucket + ".cos." + instance.mediaUploadParams.region +
			".myqcloud.com";
	} else if (instance.mediaUploadParams.storage == "oss") {
		url = "https://" + instance.mediaUploadParams.bucket + "." + instance.mediaUploadParams.region +
			".aliyuncs.com";
	} else if (instance.mediaUploadParams.storage == "local") {
		url = instance.defaults.baseURL;
	}
	return url;
}

/**
 * 获取访问URL
 */
function getVisitURL() {
	return (instance.mediaUploadParams.customDomain ? instance.mediaUploadParams.customDomain : getUploadURL());
}


/**
 * 获取上传的文件名称带路径
 * 
 * 拼接上传的文件保存目录，默认规则 baseDir/文件类型/日期/文件名称
 * 
 * @param {String} filename 文件名称
 * @param {String} dir 文件类型，目前可选为image、video、audio、files
 */
function getUploadFilePath(filename, dir = "files") {
	let key = filename;
	//完整文件名，如果设置了baseDir，则 = baseDir/filename，否则 = filename
	if (!instance.mediaUploadParams.baseDir && !instance.mediaUploadParams.storage == "local") {
		return key;
	} else {
		//文件保存根目录
		let baseDir = instance.mediaUploadParams.baseDir;
		//日期目录
		let date = new Date();
		//修复Android上日期显示异常问题
		let dateDir = date.getFullYear() + "-" + JSON.stringify(date.getMonth() + 1).padStart(2, 0) + "-" + JSON
			.stringify(date.getDate()).padStart(2, 0);
		// let dateDir = new Date().toLocaleDateString().split('/').map(item => {
		// 	if (item < 10) {
		// 		return '0' + item
		// 	} else {
		// 		return item
		// 	}
		// }).join('');

		//后半路径
		let suffix = dir + "/" + dateDir + "/" + filename;

		if (instance.mediaUploadParams.storage != "local") {
			//去除路径前的/
			if (baseDir.substring(0, 1) == "/") {
				baseDir = baseDir.substring(1);
			}
			//去除路径后的/
			if (baseDir.substring(baseDir.length - 1, baseDir.length) == "/") {
				baseDir = baseDir.substring(0, baseDir.length) + baseDir.substring(baseDir.length + 1);
			}
			//如果baseDir没了，返回不带baseDir的后半路径
			if (!baseDir) {
				return suffix;
			}
			//公有云对象存储最终保存路径
			key = baseDir + "/" + suffix;
		} else {
			//本地存储最终保存路径
			key = suffix;
		}
	}
	return key;
}

/**
 * 生成腾讯云COS 对象存储 请求签名 Authorization
 * @url https://cloud.tencent.com/document/product/436/7778
 * 
 * @param {String} method @description 请求方法名称
 * @param {String} path @description url-param-list
 * @param {String} headers @description q-header-list
 */
async function buildCosAuthorization(method, path, headers) {
	let time = parseInt((new Date()).getTime() / 1000) - 1;
	if (!instance.mediaUploadParams || time > instance.mediaUploadParams.expireTime) {
		//过期，重新获取
		await getMediaUploadParams();
	}
	let nowTime = instance.mediaUploadParams.nowTime;
	let expireTime = instance.mediaUploadParams.expireTime;
	let qSignAlgorithm = "sha1";
	let qAk = instance.mediaUploadParams.secretId;
	let qSignTime = nowTime + ";" + expireTime;
	let qKeyTime = nowTime + ";" + expireTime;
	let signKey = instance.mediaUploadParams.signKey;
	let httpString = method + "\n" + path + "\n\n" + headers + "\n";
	let stringToSign = qSignAlgorithm + "\n" + qKeyTime + "\n" + CryptoJS.SHA1(httpString) + "\n";
	let signature = CryptoJS.HmacSHA1(stringToSign, signKey);
	let authorization = "q-sign-algorithm=" + qSignAlgorithm + "&q-ak=" + qAk +
		"&q-sign-time=" + qSignTime + "&q-key-time=" + qKeyTime + "&q-header-list=&q-url-param-list=&q-signature=" +
		signature;
	return authorization;
}

/**
 * 生成阿里云OSS 对象存储 请求签名 signature
 * @url https://help.aliyun.com/document_detail/31988.html 
 */
async function buildOSSSignature() {
	let time = parseInt((new Date()).getTime() / 1000) - 1;
	if (!instance.mediaUploadParams || time > instance.mediaUploadParams.expireTime) {
		//过期，重新获取
		await getMediaUploadParams();
	}
	return instance.mediaUploadParams;
}

/**
 *
 * 通用上传接口
 * 外部暴露
 *
 * @param {Object} options
 * @param {String} options.filename @description 文件名称（需带后缀）
 * @param {String} options.filepath @description 本地文件临时路径
 * @param {Function} options.onProgress @description 上传进度回调
 */
function upload(options) {

	if (!instance.checkLogged()) {
		return errHandle(options, "请登陆后再试");
	}

	if (!instance.mediaUploadParams) {
		return log(1, "上传参数获取失败！");
	}

	let mediaUploadParams = instance.mediaUploadParams;
	let suffix = options.filename.substring(options.filename.lastIndexOf("."));
	let filename = md5((new Date()).getTime() + "_" + options.filename) + "_other" + suffix;

	//上传URL
	let uploadUrl = getUploadURL();
	//上传完成后的资源访问URL
	let resUrl = getVisitURL() + "/" + getUploadFilePath(filename);

	//腾讯云COS对象存储
	if (mediaUploadParams.storage == "cos") {

		setTimeout(async () => {
			let authorization = await buildCosAuthorization('post', '/', '');
			let uploadTask = uni.uploadFile({
				url: uploadUrl,
				name: 'file',
				formData: {
					'key': getUploadFilePath(filename),
					'success_action_status': 200,
					'Signature': authorization,
					'Content-Type': ''
				},
				header: {
					Authorization: authorization,
				},
				filePath: options.filepath,
				success: (res) => {
					successHandle(options, "success", {
						url: resUrl
					})
				},
				fail: (err) => {
					errHandle(options, err);
				}
			});
			if (options.onProgress !== undefined && typeof options.onProgress === "function") {
				uploadTask.onProgressUpdate((res) => {
					options.onProgress(res);
				});
			}
		}, 0);
	} else if (mediaUploadParams.storage == "oss") {

		//阿里云对象存储 
		setTimeout(async () => {
			await buildOSSSignature();
			let uploadTask = uni.uploadFile({
				url: uploadUrl,
				name: 'file',
				formData: {
					'key': getUploadFilePath(filename),
					'policy': mediaUploadParams.policyBase64,
					'OSSAccessKeyId': mediaUploadParams.accessKeyId,
					'success_action_status': 200,
					'signature': mediaUploadParams.signature,
				},
				filePath: options.filepath,
				success: (res) => {
					successHandle(options, "success", {
						url: resUrl
					})
				},
				fail: (err) => {
					errHandle(options, err);
				}
			});
			if (options.onProgress !== undefined && typeof options.onProgress === "function") {
				uploadTask.onProgressUpdate((res) => {
					options.onProgress(res);
				});
			}
		});
	} else if (mediaUploadParams.storage == "local") {

		//本地上传 
		let uploadTask = uni.uploadFile({
			url: uploadUrl + "/upload",
			name: 'file',
			formData: {
				'key': getUploadFilePath(filename)
			},
			header: {
				'token': instance.token
			},
			filePath: options.filepath,
			success: (uploadResponse) => {
				let data = JSON.parse(uploadResponse.data);
				if (data.code == 200) {
					successHandle(options, "success", {
						url: getVisitURL() + data.data.url,
					})
				} else {
					errHandle(options, data.message);
				}
			},
			fail: (err) => {
				errHandle(options, err);
			}
		});
		if (options.onProgress !== undefined && typeof options.onProgress === "function") {
			uploadTask.onProgressUpdate((res) => {
				options.onProgress(res);
			});
		}
	}

}

/**
 *
 * 上传图片
 * 外部暴露
 *
 * @param {Object} options
 * @param {String} options.filename @description 文件名称
 * @param {String} options.filepath @description 本地图片文件临时路径
 * @param {Number} options.width @description 图片宽度
 * @param {Number} options.height @description 图片高度
 * @param {Function} options.onProgress @description 上传进度回调
 */
function uploadImage(options) {
	if (!instance.mediaUploadParams) {
		return log(1, "媒体上传参数获取失败！");
	}
	let mediaUploadParams = instance.mediaUploadParams;
	let suffix = options.filename.substring(options.filename.lastIndexOf("."));
	let filename = md5((new Date()).getTime() + "_" + options.filename) + "_image" + suffix;

	//上传URL
	let uploadUrl = getUploadURL();
	//上传完成后的资源访问URL
	let resUrl = getVisitURL() + "/" + getUploadFilePath(filename, "image");

	//腾讯云COS对象存储
	if (mediaUploadParams.storage == "cos") {

		setTimeout(async () => {
			let authorization = await buildCosAuthorization('post', '/', '');
			let uploadTask = uni.uploadFile({
				url: uploadUrl,
				name: 'file',
				formData: {
					'key': getUploadFilePath(filename, "image"),
					'success_action_status': 200,
					'Signature': authorization,
					'Content-Type': ''
				},
				header: {
					Authorization: authorization,
				},
				filePath: options.filepath,
				success: () => {

					let thumbnailHeight = 0;
					let thumbnailWidth = 0;

					if (options.height > 198) {
						let d = 198 / options.height;
						thumbnailHeight = parseInt(options.height *
							d);
						thumbnailWidth = parseInt(options.width * d);
					} else if (options.width > 198) {
						let d = 198 / options.width;
						thumbnailHeight = parseInt(options.height *
							d);
						thumbnailWidth = parseInt(options.width * d);
					}

					let thumbnailUrl = resUrl + "?imageMogr2/thumbnail/" + thumbnailWidth +
						"x" + thumbnailHeight;

					successHandle(options, "success", {
						url: resUrl,
						thumbnailUrl: thumbnailUrl,
						thumbnailWidth: thumbnailWidth,
						thumbnailHeight: thumbnailHeight
					})

				},
				fail: (err) => {
					errHandle(options, err);
				}
			});
			if (options.onProgress !== undefined && typeof options.onProgress === "function") {
				uploadTask.onProgressUpdate((res) => {
					options.onProgress(res);
				});
			}
		}, 0);
	} else if (mediaUploadParams.storage == "oss") {

		//阿里云对象存储   
		setTimeout(async () => {
			await buildOSSSignature();
			let uploadTask = uni.uploadFile({
				url: uploadUrl,
				name: 'file',
				formData: {
					'key': getUploadFilePath(filename, "image"),
					'policy': mediaUploadParams.policyBase64,
					'OSSAccessKeyId': mediaUploadParams.accessKeyId,
					'success_action_status': 200,
					'signature': mediaUploadParams.signature,
				},
				filePath: options.filepath,
				success: () => {

					//阿里云图片缩放
					let thumbnailHeight = 0;
					let thumbnailWidth = 0;

					if (options.height > 198) {
						let d = 198 / options.height;
						thumbnailHeight = parseInt(options.height *
							d);
						thumbnailWidth = parseInt(options.width * d);
					} else if (options.width > 198) {
						let d = 198 / options.width;
						thumbnailHeight = parseInt(options.height *
							d);
						thumbnailWidth = parseInt(options.width * d);
					}

					let thumbnailUrl = resUrl + "?x-oss-process=image/resize,m_fixed,h_" +
						thumbnailHeight + ",w_" + thumbnailWidth;

					successHandle(options, "success", {
						url: resUrl,
						thumbnailUrl: thumbnailUrl,
						thumbnailWidth: thumbnailWidth,
						thumbnailHeight: thumbnailHeight
					})
				},
				fail: (err) => {
					errHandle(options, err);
				}
			});
			if (options.onProgress !== undefined && typeof options.onProgress === "function") {
				uploadTask.onProgressUpdate((res) => {
					options.onProgress(res);
				});
			}
		});
	} else if (mediaUploadParams.storage == "local") {
		console.log(getUploadFilePath(filename, "image"))
		//本地上传 
		let uploadTask = uni.uploadFile({
			url: uploadUrl + "/upload/image",
			name: 'file',
			formData: {
				'key': getUploadFilePath(filename, "image")
			},
			header: {
				'token': instance.token
			},
			filePath: options.filepath,
			success: (uploadResponse) => {

				let data = JSON.parse(uploadResponse.data);
				if (data.code == 200) {
					successHandle(options, "success", {
						url: getVisitURL() + data.data.url,
						thumbnailUrl: getVisitURL() + data.data.thumbnailUrl,
						thumbnailWidth: data.data.thumbnailWidth,
						thumbnailHeight: data.data.thumbnailHeight
					})
				} else {
					errHandle(options, data.message);
				}


			},
			fail: (err) => {
				errHandle(options, err);
			}
		});
		if (options.onProgress !== undefined && typeof options.onProgress === "function") {
			uploadTask.onProgressUpdate((res) => {
				options.onProgress(res);
			});
		}
	}
}

/**
 * 上传音频
 *
 * @param {Object} options
 * @param {String} options.filename @description 文件名称
 * @param {String} options.filepath @description 本地文件临时路径
 * @param {Function} options.onProgress @description 上传进度回调
 */
function uploadAudio(options) {
	if (!instance.mediaUploadParams) {
		return log(1, "媒体上传参数获取失败！");
	}
	let mediaUploadParams = instance.mediaUploadParams;
	let suffix = options.filename.substring(options.filename.lastIndexOf("."));
	let filename = md5((new Date()).getTime() + "_" + options.filename) + "_audio" + suffix;

	//上传URL
	let uploadUrl = getUploadURL();
	//上传完成后的资源访问URL
	let resUrl = getVisitURL() + "/" + getUploadFilePath(filename, "audio");

	//腾讯云COS对象存储
	if (mediaUploadParams.storage == "cos") {

		setTimeout(async () => {
			let authorization = await buildCosAuthorization('post', '/', '');
			let uploadTask = uni.uploadFile({
				url: uploadUrl,
				name: 'file',
				formData: {
					'key': getUploadFilePath(filename, "audio"),
					'success_action_status': 200,
					'Signature': authorization,
					'Content-Type': ''
				},
				header: {
					Authorization: authorization,
				},
				filePath: options.filepath,
				success: (res) => {
					successHandle(options, "success", {
						url: resUrl
					})
				},
				fail: (err) => {
					errHandle(options, err);
				}
			});
			if (options.onProgress !== undefined && typeof options.onProgress === "function") {
				uploadTask.onProgressUpdate((res) => {
					options.onProgress(res);
				});
			}
		}, 0);
	} else if (mediaUploadParams.storage == "oss") {

		//阿里云对象存储 
		setTimeout(async () => {
			await buildOSSSignature();
			let uploadTask = uni.uploadFile({
				url: uploadUrl,
				name: 'file',
				formData: {
					'key': getUploadFilePath(filename, "audio"),
					'policy': mediaUploadParams.policyBase64,
					'OSSAccessKeyId': mediaUploadParams.accessKeyId,
					'success_action_status': 200,
					'signature': mediaUploadParams.signature,
				},
				filePath: options.filepath,
				success: (res) => {
					successHandle(options, "success", {
						url: resUrl
					})
				},
				fail: (err) => {
					errHandle(options, err);
				}
			});
			if (options.onProgress !== undefined && typeof options.onProgress === "function") {
				uploadTask.onProgressUpdate((res) => {
					options.onProgress(res);
				});
			}
		});
	} else if (mediaUploadParams.storage == "local") {
		//本地上传 
		let uploadTask = uni.uploadFile({
			url: uploadUrl + "/upload",
			name: 'file',
			formData: {
				'key': getUploadFilePath(filename, "audio")
			},
			header: {
				'token': instance.token
			},
			filePath: options.filepath,
			success: (uploadResponse) => {
				let data = JSON.parse(uploadResponse.data);
				if (data.code == 200) {
					successHandle(options, "success", {
						url: getVisitURL() + data.data.url,
					})
				} else {
					errHandle(options, data.message);
				}
			},
			fail: (err) => {
				errHandle(options, err);
			}
		});
		if (options.onProgress !== undefined && typeof options.onProgress === "function") {
			uploadTask.onProgressUpdate((res) => {
				options.onProgress(res);
			});
		}
	}

}


/**
 * 上传视频
 *
 * @param {Object} options
 * @param {String} options.filename - 文件名称
 * @param {String} options.filepath - 本地文件临时路径
 * @param {(result)=>{}} options.onProgress - 上传进度回调
 */
function uploadVideo(options) {
	if (!instance.mediaUploadParams) {
		return log(1, "媒体上传参数获取失败！");
	}
	let mediaUploadParams = instance.mediaUploadParams;
	let suffix = options.filename.substring(options.filename.lastIndexOf("."));
	let filename = md5((new Date()).getTime() + "_" + options.filename) + "_video" + suffix;

	//上传URL
	let uploadUrl = getUploadURL();
	//上传完成后的资源访问URL
	let resUrl = getVisitURL() + "/" + getUploadFilePath(filename, "video");

	//腾讯云COS对象存储
	if (mediaUploadParams.storage == "cos") {
		setTimeout(async () => {
			let postAuthorization = await buildCosAuthorization('post', '/', '');
			let uploadTask = uni.uploadFile({
				url: uploadUrl,
				name: 'file',
				formData: {
					'key': getUploadFilePath(filename, "video"),
					'success_action_status': 200,
					'Signature': postAuthorization,
					'Content-Type': ''
				},
				header: {
					Authorization: postAuthorization,
				},
				filePath: options.filepath,
				success: async () => {
					let getAuthorization = await buildCosAuthorization('get', "/" +
						getUploadFilePath(filename, "video"), '');
					//下载视频缩略图，腾讯云COS 媒体截图接口：https://cloud.tencent.com/document/product/436/55671
					uni.downloadFile({
						url: uploadUrl + "/" + getUploadFilePath(filename, "video") +
							"?ci-process=snapshot&time=1",
						header: {
							'Authorization': getAuthorization
						},
						success: (downloadRes) => {
							if (downloadRes.statusCode === 200) {
								uploadImage({
									filename: md5(filename + downloadRes
											.tempFilePath) +
										"_videoThumb.jpg",
									filepath: downloadRes.tempFilePath,
									success: (thumb) => {
										successHandle(options,
											"success", {
												videoUrl: resUrl,
												thumbnailUrl: thumb
													.data.url
											});
									},
									fail: (err) => {
										errHandle(options, err);
									}
								})
							} else {
								errHandle(options, "腾讯云媒体截图接口：下载视频缩略图失败");
							}
						},
						fail: (err) => {
							errHandle(options, "腾讯云媒体截图接口：下载视频缩略图失败");
						}
					});

				},
				fail: (err) => {
					errHandle(options, err);
				}
			});
			if (options.onProgress !== undefined && typeof options.onProgress === "function") {
				uploadTask.onProgressUpdate((res) => {
					options.onProgress(res);
				});
			}
		}, 0);
	} else if (mediaUploadParams.storage == "oss") {

		//阿里云对象存储 
		setTimeout(async () => {
			await buildOSSSignature();
			let uploadTask = uni.uploadFile({
				url: uploadUrl,
				name: 'file',
				formData: {
					'key': getUploadFilePath(filename, "video"),
					'policy': mediaUploadParams.policyBase64,
					'OSSAccessKeyId': mediaUploadParams.accessKeyId,
					'success_action_status': 200,
					'signature': mediaUploadParams.signature,
				},
				filePath: options.filepath,
				success: (res) => {
					//阿里云视频截帧
					//?x-oss-process=video/snapshot,t_1000,f_jpg,m_fast 
					successHandle(options, "success", {
						videoUrl: resUrl,
						thumbnailUrl: resUrl +
							"?x-oss-process=video/snapshot,t_1000,f_jpg,m_fast"
					})
				},
				fail: (err) => {
					errHandle(options, err);
				}
			});
			if (options.onProgress !== undefined && typeof options.onProgress === "function") {
				uploadTask.onProgressUpdate((res) => {
					options.onProgress(res);
				});
			}
		});
	} else if (mediaUploadParams.storage == "local") {
		//本地上传 
		let uploadTask = uni.uploadFile({
			url: uploadUrl + "/upload/video",
			name: 'file',
			formData: {
				'key': getUploadFilePath(filename, "video")
			},
			header: {
				'token': instance.token
			},
			filePath: options.filepath,
			success: (uploadResponse) => {
				let data = JSON.parse(uploadResponse.data);
				if (data.code == 200) {
					successHandle(options, "success", {
						videoUrl: getVisitURL() + data.data.url,
						thumbnailUrl: getVisitURL() + data.data.thumbnailUrl,
					})
				} else {
					errHandle(options, data.message);
				}
			},
			fail: (err) => {
				errHandle(options, err);
			}
		});
		if (options.onProgress !== undefined && typeof options.onProgress === "function") {
			uploadTask.onProgressUpdate((res) => {
				options.onProgress(res);
			});
		}
	}
}

export {
	getMediaUploadParams,
	upload,
	uploadImage,
	uploadAudio,
	uploadVideo
}
