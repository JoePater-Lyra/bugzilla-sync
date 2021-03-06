const bugzilla_api_key = "8Nxanhyh9xJEcpK92TgF4cRQHryrCIlyGE0IVCRy";
const bugzilla_url = "https://bugzilla.lyra.local/";
const include_fields = [
    "summary", "id", "assigned_to", "blocks", "deadline", "status", "severity",
    "priority", "component,cf_origin"
];

var doc;

var bug_list = [];
var bug_map = new Map(); // Map from bug id to bug object
var task_map = new Map(); // Map from bug ID to task GUID

var pf;
var proj_to_bz_fields;

function process_bugs(bugs) {
    bug_list = bugs;
    bug_map = new Map();
    let str = "";
    for (b in bugs) {
	bug_map.set(bugs[b].id, bugs[b]);
	str += bugs[b].summary + "\n";
    }
}

function option_html(value, str) {
    return "<option value='" + value + "'>" + str + "</option>";
}

function update_product_list() {
    var url = bugzilla_url + "rest/product?type=selectable&api_key=" + bugzilla_api_key;
    return $.get(url).then(function (data) {
	var select = document.getElementById("prod_select");
	var str = option_html("__ALL__", "All (default)");
	for (p in data.products) {
	    const pname = data.products[p].name;
	    str += option_html(pname, pname);
	}
	select.innerHTML = str;
    }, function (data) {
	console.log("Failed to get product list");
    });
}

function read_bugs(ids=[]) {
    var prod = document.getElementById("prod_select").value;
    var products = [];
    if (prod != "__ALL__") {
	products.push(prod);
    }
    
    let req_params = "";
    for (p in products) {
    	req_params += "product=" + products[p] + "&";
    }
    for (i in ids) {
	req_params += "id=" + ids[i] + "&";
    }
    req_params += "include_fields=" + include_fields.join(",") + "&";
    req_params += "api_key=" + bugzilla_api_key;

    const url = encodeURI(bugzilla_url + "rest/bug?" + req_params);
    console.log(url);
    return $.get(url).then(function (data) {
	process_bugs(data.bugs);
    }, function(data) {
	console.log("GET failed");
    });
}

function read_bug_comments(bug_id) {
    const url = bugzilla_url + "rest/bug/" + bug_id + "/comment?api_key=" + bugzilla_api_key;
    return $.get(url).then(function (data) {
	return data.bugs[bug_id.toString()].comments;
    });
}

function get_task_field(guid, field_id) {
    return new Promise(function (resolve, reject) {
	doc.getTaskFieldAsync(guid, field_id, function (res) {
	    if (res.status == Office.AsyncResultStatus.Succeeded) resolve(res.value.fieldValue);
	    else reject(res.status);
	});
    });
}

function get_task(index) {
    return new Promise(function (resolve, reject) {
	doc.getTaskByIndexAsync(index, function (res) {
	    if (res.status == Office.AsyncResultStatus.Succeeded) {
		resolve(res.value);
	    } else {
		reject(res.status);
	    }
	});
    });
}

var progress_total = 0;
var progress_count = 0;

function start_progress(count) {
    progress_count = 0;
    progress_total = count;
    document.getElementById("tasks_done").innerText = "0";
    document.getElementById("total_tasks").innerText = count.toString();
    document.getElementById("progress").style.display = "block";
}

function incr_progress() {
    progress_count++;
    document.getElementById("tasks_done").innerText = progress_count.toString();
    if (progress_count == progress_total) {
	document.getElementById("progress").style.display = "none";
    }
}

// callback passed GUID of task and may return a promise
function do_all_tasks(callback) {
    doc.getMaxTaskIndexAsync(async function (res) {
	if (res.status == Office.AsyncResultStatus.Succeeded) {
	    max_index = res.value;
	    for (let i=0; i <= max_index; i++) {
		await get_task(i).then(callback, function () {
		    console.log("Failed to get task " + i)
		});
	    }
	} else {
	    console.log("Failed to get max index");
	}
    });
}

function set_task_field(guid, field_id, value) {
    return new Promise(function (resolve, reject) {
	doc.setTaskFieldAsync(guid, field_id, value, function (res) {
	    if (res.status == Office.AsyncResultStatus.Succeeded) {
		resolve(res.value);
	    } else {
		reject(res.status);
	    }
	});
    });
}

async function update_task_resources(guid, bug) {
    let task_resource = await get_task_field(guid, pf.ResourceNames);
    let resource_names = task_resource.split(",").filter((str) => str != "");
    let bz_assignee = bug.assigned_to_detail.real_name;

    if (!resource_names.includes(bz_assignee)) {
	resource_names.push(bz_assignee);
    }
    console.log(resource_names);
    task_resource = resource_names.join(",");
    console.log(task_resource);
    await set_task_field(guid, pf.ResourceNames, task_resource);
}

async function update_task_notes(guid, bug) {
    let comments = await read_bug_comments(bug.id);
    let str = ""
    for (i in comments) {
	str += comments[i].text + "\n--------------------------\n";
    }
    await set_task_field(guid, pf.Notes, str);
}

async function update_successors(guid, bug) {
    let blocks = bug.blocks;
    let id_list = (await get_task_field(guid, pf.Successors)).split(",").filter(
	(str) => str != "");
    
    for (i in blocks) {
	if (task_map.has(blocks[i])) {
	    const new_guid = task_map.get(blocks[i]);
	    const new_id = (await get_task_field(new_guid, pf.ID)).toString();
	    const dependency_type = "FS";
	    if (!id_list.includes(new_id))
		id_list.push(new_id + dependency_type);
	}
    }
    console.log(id_list);
    const str = id_list.join(",");
    await set_task_field(guid, pf.Successors, str);
}

async function update_task(guid) {
    let bug_id = await get_task_field(guid, pf.Number5);

    if (!bug_map.has(bug_id)) return;
    bug = bug_map.get(bug_id);
    
    // Update deadline
    if (bug.deadline != null) {
	let date = new Date(bug.deadline);
	let date_str = date.getDate() + "/" + (date.getMonth() + 1) + "/" + date.getFullYear()
	await set_task_field(guid, pf.Deadline, date_str);
    }

    // Update attributes that are just copied
    for (bz_attr in bz_to_proj_fields) {
	let field_id = bz_to_proj_fields[bz_attr];
	await set_task_field(guid, field_id, bug[bz_attr]);
    }

    // Update resources
    await update_task_resources(guid, bug);

    // Update Notes
    await update_task_notes(guid, bug);

    // Update Successors
    await update_successors(guid, bug);
}

async function maybe_update_task(guid) {
    let prevent_update = await get_task_field(guid, pf.Flag19);
    let bugid = await get_task_field(guid, pf.Number5);
    console.log("prevent_update: ", prevent_update, bugid);
    if (prevent_update === false)
    	await update_task(guid);
    incr_progress();
}

async function fill_task_map() {
    await do_all_tasks(async function (guid) {
	let bug_id = await get_task_field(guid, pf.Number5);
	if (bug_id != 0)
	    task_map.set(bug_id, guid);
	incr_progress();
    });
}		       

async function update_all_tasks() {
    doc.getMaxTaskIndexAsync(async function (res) {
	start_progress(res.value * 2);
	await read_bugs();
	await fill_task_map();
	await do_all_tasks(maybe_update_task);
    });
}

async function update_selected_task() {
    await read_bugs();
    doc.getSelectedTaskAsync(async function (res) {
	if (res.status == Office.AsyncResultStatus.Succeeded) {
	    var guid = res.value;
	    await maybe_update_task(guid);
	}
    });
}

async function track_selected_task() {
    await read_bugs();
    var bug_id = document.getElementById("bug_id").value;
    doc.getSelectedTaskAsync(async function (res) {
	if (res.status == Office.AsyncResultStatus.Succeeded) {
	    var guid = res.value;
	    await set_task_field(guid, pf.Number5, bug_id);
	    await maybe_update_task(guid);
	}
    });
}

function read_flag19() {
    doc.getSelectedTaskAsync(async function (res) {
	if (res.status == Office.AsyncResultStatus.Succeeded) {
	    var guid = res.value;
	    var flag = await get_task_field(guid, pf.Flag19);
	    console.log(flag);
	}
    });
}

Office.initialize = function (reason) {
    $(document).ready(async function () {
	doc = Office.context.document
	pf = Office.ProjectTaskFields;
	bz_to_proj_fields = {
	    status: pf.Text9,
	    severity: pf.Text8,
	    priority: pf.Text7,
	    component: pf.Text6,
	    cf_origin: pf.Text5,
	    summary: pf.Name,
	};
	await update_product_list();
	document.getElementById("main").style.display = "block";
    });
}
