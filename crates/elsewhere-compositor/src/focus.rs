//! Pointer and touch targets retain X11 identity for Smithay's XDND bridge.

use std::{borrow::Cow, sync::Arc};
use smithay::{
    backend::input::InputTime,
    input::{Seat, dnd::{DndFocus, OfferData, Source}, pointer::*, touch::{FrameMarker, TouchTarget}},
    reexports::wayland_server::{DisplayHandle, backend::ObjectId, protocol::wl_surface::WlSurface},
    utils::{IsAlive, Logical, Point, Serial},
    wayland::{seat::WaylandFocus, selection::data_device::WlOfferData},
    xwayland::{X11Surface, xwm::XwmOfferData},
};
use crate::{State, handlers::KeyboardFocus};

#[derive(Clone, Debug, PartialEq)]
pub enum PointerFocus {
    Wayland(WlSurface),
    X11(X11Surface),
}

impl From<WlSurface> for PointerFocus {
    fn from(surface: WlSurface) -> Self { Self::Wayland(surface) }
}

impl From<KeyboardFocus> for PointerFocus {
    fn from(focus: KeyboardFocus) -> Self {
        match focus {
            KeyboardFocus::Wayland(s) => Self::Wayland(s),
            KeyboardFocus::X11(x) => Self::X11(x),
        }
    }
}

impl IsAlive for PointerFocus {
    fn alive(&self) -> bool {
        match self { Self::Wayland(s) => s.alive(), Self::X11(x) => x.alive() }
    }
}

impl WaylandFocus for PointerFocus {
    fn wl_surface(&self) -> Option<Cow<'_, WlSurface>> {
        match self { Self::Wayland(s) => Some(Cow::Borrowed(s)), Self::X11(x) => x.wl_surface().map(Cow::Owned) }
    }
    fn same_client_as(&self, id: &ObjectId) -> bool {
        match self { Self::Wayland(s) => s.same_client_as(id), Self::X11(x) => x.same_client_as(id) }
    }
}

impl PointerFocus {
    fn pointer(&self) -> &dyn PointerTarget<State> {
        match self { Self::Wayland(s) => s, Self::X11(x) => x }
    }
    fn touch(&self) -> &dyn TouchTarget<State> {
        match self { Self::Wayland(s) => s, Self::X11(x) => x }
    }
}

impl PointerTarget<State> for PointerFocus {
    fn enter(&self, seat: &Seat<State>, data: &mut State, event: &MotionEvent) {
        self.pointer().enter(seat, data, event)
    }
    fn motion(&self, seat: &Seat<State>, data: &mut State, event: &MotionEvent) {
        self.pointer().motion(seat, data, event)
    }
    fn relative_motion(&self, seat: &Seat<State>, data: &mut State, event: &RelativeMotionEvent) {
        self.pointer().relative_motion(seat, data, event)
    }
    fn button(&self, seat: &Seat<State>, data: &mut State, event: &ButtonEvent) {
        self.pointer().button(seat, data, event)
    }
    fn axis(&self, seat: &Seat<State>, data: &mut State, frame: AxisFrame) {
        self.pointer().axis(seat, data, frame)
    }
    fn frame(&self, seat: &Seat<State>, data: &mut State) {
        self.pointer().frame(seat, data)
    }
    fn leave(&self, seat: &Seat<State>, data: &mut State, serial: Serial, time: InputTime) {
        self.pointer().leave(seat, data, serial, time)
    }
    fn gesture_swipe_begin(&self, seat: &Seat<State>, data: &mut State, event: &GestureSwipeBeginEvent) {
        self.pointer().gesture_swipe_begin(seat, data, event)
    }
    fn gesture_swipe_update(&self, seat: &Seat<State>, data: &mut State, event: &GestureSwipeUpdateEvent) {
        self.pointer().gesture_swipe_update(seat, data, event)
    }
    fn gesture_swipe_end(&self, seat: &Seat<State>, data: &mut State, event: &GestureSwipeEndEvent) {
        self.pointer().gesture_swipe_end(seat, data, event)
    }
    fn gesture_pinch_begin(&self, seat: &Seat<State>, data: &mut State, event: &GesturePinchBeginEvent) {
        self.pointer().gesture_pinch_begin(seat, data, event)
    }
    fn gesture_pinch_update(&self, seat: &Seat<State>, data: &mut State, event: &GesturePinchUpdateEvent) {
        self.pointer().gesture_pinch_update(seat, data, event)
    }
    fn gesture_pinch_end(&self, seat: &Seat<State>, data: &mut State, event: &GesturePinchEndEvent) {
        self.pointer().gesture_pinch_end(seat, data, event)
    }
    fn gesture_hold_begin(&self, seat: &Seat<State>, data: &mut State, event: &GestureHoldBeginEvent) {
        self.pointer().gesture_hold_begin(seat, data, event)
    }
    fn gesture_hold_end(&self, seat: &Seat<State>, data: &mut State, event: &GestureHoldEndEvent) {
        self.pointer().gesture_hold_end(seat, data, event)
    }
}

impl TouchTarget<State> for PointerFocus {
    fn down(&self, seat: &Seat<State>, data: &mut State, event: &smithay::input::touch::DownEvent) {
        self.touch().down(seat, data, event)
    }
    fn up(&self, seat: &Seat<State>, data: &mut State, event: &smithay::input::touch::UpEvent) {
        self.touch().up(seat, data, event)
    }
    fn motion(&self, seat: &Seat<State>, data: &mut State, event: &smithay::input::touch::MotionEvent) {
        self.touch().motion(seat, data, event)
    }
    fn shape(&self, seat: &Seat<State>, data: &mut State, event: &smithay::input::touch::ShapeEvent) {
        self.touch().shape(seat, data, event)
    }
    fn orientation(&self, seat: &Seat<State>, data: &mut State, event: &smithay::input::touch::OrientationEvent) {
        self.touch().orientation(seat, data, event)
    }
    fn frame(&self, seat: &Seat<State>, data: &mut State, marker: FrameMarker) {
        self.touch().frame(seat, data, marker)
    }
    fn cancel(&self, seat: &Seat<State>, data: &mut State, marker: FrameMarker) {
        self.touch().cancel(seat, data, marker)
    }
    fn last_frame(&self, seat: &Seat<State>, data: &mut State) -> Option<FrameMarker> {
        self.touch().last_frame(seat, data)
    }
}

pub enum DragOffer<S: Source> {
    Wayland(WlOfferData<S>),
    X11(XwmOfferData<S>),
}

impl<S: Source> OfferData for DragOffer<S> {
    fn disable(&self) {
        match self { Self::Wayland(o) => o.disable(), Self::X11(o) => o.disable() }
    }
    fn drop(&self) {
        match self { Self::Wayland(o) => o.drop(), Self::X11(o) => o.drop() }
    }
    fn validated(&self) -> bool {
        match self { Self::Wayland(o) => o.validated(), Self::X11(o) => o.validated() }
    }
}

impl DndFocus<State> for PointerFocus {
    type OfferData<S: Source> = DragOffer<S>;

    fn enter<S: Source>(&self, data: &mut State, dh: &DisplayHandle, source: Arc<S>, seat: &Seat<State>, location: Point<f64, Logical>, serial: &Serial) -> Option<DragOffer<S>> {
        match self {
            Self::Wayland(s) => DndFocus::enter(s, data, dh, source, seat, location, serial).map(DragOffer::Wayland),
            Self::X11(x) => DndFocus::enter(x, data, dh, source, seat, location, serial).map(DragOffer::X11),
        }
    }
    fn motion<S: Source>(&self, data: &mut State, offer: Option<&mut DragOffer<S>>, seat: &Seat<State>, location: Point<f64, Logical>, time: InputTime) {
        match (self, offer) {
            (Self::Wayland(s), Some(DragOffer::Wayland(o))) => DndFocus::motion::<S>(s, data, Some(o), seat, location, time),
            (Self::Wayland(s), None) => DndFocus::motion::<S>(s, data, None, seat, location, time),
            (Self::X11(x), Some(DragOffer::X11(o))) => DndFocus::motion::<S>(x, data, Some(o), seat, location, time),
            (Self::X11(x), None) => DndFocus::motion::<S>(x, data, None, seat, location, time),
            _ => {}
        }
    }
    fn leave<S: Source>(&self, data: &mut State, offer: Option<&mut DragOffer<S>>, seat: &Seat<State>) {
        match (self, offer) {
            (Self::Wayland(s), Some(DragOffer::Wayland(o))) => DndFocus::leave::<S>(s, data, Some(o), seat),
            (Self::Wayland(s), None) => DndFocus::leave::<S>(s, data, None, seat),
            (Self::X11(x), Some(DragOffer::X11(o))) => DndFocus::leave::<S>(x, data, Some(o), seat),
            (Self::X11(x), None) => DndFocus::leave::<S>(x, data, None, seat),
            _ => {}
        }
    }
    fn drop<S: Source>(&self, data: &mut State, offer: Option<&mut DragOffer<S>>, seat: &Seat<State>) {
        match (self, offer) {
            (Self::Wayland(s), Some(DragOffer::Wayland(o))) => DndFocus::drop::<S>(s, data, Some(o), seat),
            (Self::Wayland(s), None) => DndFocus::drop::<S>(s, data, None, seat),
            (Self::X11(x), Some(DragOffer::X11(o))) => {
                // XWM sends XdndDrop even for a refused offer. The grab's leave cleans it up.
                if o.validated() {
                    DndFocus::drop::<S>(x, data, Some(o), seat);
                }
            }
            (Self::X11(x), None) => DndFocus::drop::<S>(x, data, None, seat),
            _ => {}
        }
    }
}
